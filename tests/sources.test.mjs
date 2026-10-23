// Source adapters: text safety, HTTP classification, CSV/JSON import, Greenhouse. Local tests with fakes and
// fixtures captured from the real Greenhouse API. Nothing here contacts a real server.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeEntities, htmlToText, plainLine } from "../src/sources/text.js";
import { SourceError, fetchJson, parseRetryAfter } from "../src/sources/http.js";
import { CsvError, parseCsv } from "../src/sources/csv.js";
import { FILE_LIMITS, createFileSource, parseImportFile, sanitizeRecord } from "../src/sources/file-import.js";
import { BOARD_TOKEN_RE, createGreenhouseSource } from "../src/sources/greenhouse.js";
import { assertJobSource, createSourceRegistry } from "../src/sources/registry.js";
import { toRow } from "../src/db/job-mapper.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures", n), "utf8"));
const LIST = fixture("greenhouse-board-list.json");
const DETAIL = fixture("greenhouse-job-detail.json");
const NOW = new Date("2026-10-22T12:00:00Z");

// ================================================================== text.js
test("decodeEntities: named, numeric, hex; unknown names kept; invalid code points and control chars dropped", () => {
  assert.equal(decodeEntities("a &amp; b &lt;i&gt; &quot;q&quot; &#39;x&#39; &#x27;y&#x27; &rsquo;"), "a & b <i> \"q\" 'x' 'y' '");
  // unknown names stay; NUL, control, surrogate code points are dropped; 8-digit numeric refs are not entities
  assert.equal(decodeEntities("&unknownthing; &#0; &#1; &#xD800; ok"), "&unknownthing;    ok");
  assert.equal(decodeEntities("&#99999999;"), "&#99999999;");
  assert.equal(decodeEntities("tab&#9;new&#10;line"), "tab\tnew\nline");
});

test("htmlToText: block tags become line breaks, list items become bullets, every tag is removed", () => {
  const out = htmlToText("<div><p>Intro</p><ul><li>One</li><li>Two<br>three</li></ul><h2>Head</h2>Tail</div>");
  assert.equal(out, "Intro\n\n- One\n- Two\nthree\nHead\nTail");
  assert.doesNotMatch(out, /[<>]/);
});

test("htmlToText: scripts, styles, comments, iframes and event-handler attributes never survive", () => {
  const evil = '<script>alert(1)</script><style>body{x:y}</style><!-- c --><iframe src="javascript:x"></iframe><img src=x onerror="alert(1)"><a href="javascript:alert(1)" onclick="x()">Click</a><b>Bold</b>';
  const out = htmlToText(evil);
  assert.equal(out, "ClickBold");
  assert.doesNotMatch(out, /alert|javascript|onerror|onclick|style|script/i);
});

test("htmlToText: escaped HTML (as sent by Greenhouse) is decoded once, then stripped; double-escaped text is decoded", () => {
  assert.equal(htmlToText("&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;", { escaped: true }), "Hello & welcome");
  assert.equal(htmlToText("&lt;script&gt;alert(1)&lt;/script&gt;&lt;b&gt;ok&lt;/b&gt;", { escaped: true }), "ok");
  assert.equal(htmlToText("&lt;p&gt;x&lt;/p&gt;"), "<p>x</p>".replace(/<[^>]*>/g, "") === "x" ? "<p>x</p>" : "", "without `escaped`, encoded markup is just text");
});

test("htmlToText: stray angle brackets in text are preserved; control characters removed; length capped; null-safe", () => {
  assert.equal(htmlToText("5 < 6 and 7 > 3"), "5 < 6 and 7 > 3");
  assert.equal(htmlToText("a\u0000b\u0007c​d"), "abcd");
  assert.equal(htmlToText("x".repeat(50), { maxLength: 10 }).length, 10);
  assert.equal(htmlToText(null), "");
  assert.equal(htmlToText(undefined), "");
  assert.equal(plainLine("  <b>Senior</b>\n  Designer  "), "Senior Designer");
});

// ================================================================== http.js
const res = (status, body = "{}", headers = {}) => async () => new Response(body, { status, headers });
const kind = async (p) => p.then(() => "ok", (e) => (e instanceof SourceError ? e : new Error("not a SourceError: " + e)));

test("fetchJson: success parses JSON and sends a credential-free GET that refuses redirects", async () => {
  let init;
  const out = await fetchJson("https://x.example/a", { fetchImpl: async (u, i) => { init = i; return new Response('{"a":1}', { status: 200 }); } });
  assert.deepEqual(out, { a: 1 });
  assert.equal(init.method, "GET");
  assert.equal(init.credentials, "omit");
  assert.equal(init.redirect, "error");
  assert.ok(!("body" in init));
});

test("fetchJson: status codes map to error kinds the controller can act on", async () => {
  const k = async (status, headers) => (await kind(fetchJson("https://x.example", { fetchImpl: res(status, "{}", headers) }))).kind;
  assert.equal(await k(404), "not-found");
  assert.equal(await k(429), "rate-limited");
  assert.equal(await k(503, { "retry-after": "5" }), "rate-limited");
  assert.equal(await k(503), "transient");
  for (const s of [500, 502, 504, 408, 425]) assert.equal(await k(s), "transient", String(s));
  for (const s of [400, 401, 403, 410, 418]) assert.equal(await k(s), "fatal", String(s));
});

test("fetchJson: 429 carries Retry-After in milliseconds (seconds or HTTP date), clamped", async () => {
  const e1 = await kind(fetchJson("https://x.example", { fetchImpl: res(429, "{}", { "retry-after": "7" }) }));
  assert.equal(e1.retryAfterMs, 7000);
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter("999999999"), 3600000);
  assert.equal(parseRetryAfter("garbage"), null);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(new Date(Date.now() - 5000).toUTCString()), 0, "a date in the past means retry now");
  const future = parseRetryAfter(new Date(Date.now() + 30000).toUTCString());
  assert.ok(future > 25000 && future <= 30000);
});

test("fetchJson: malformed JSON, oversized bodies and network failures are classified", async () => {
  assert.equal((await kind(fetchJson("https://x.example", { fetchImpl: res(200, "<html>nope") }))).kind, "malformed");
  assert.equal((await kind(fetchJson("https://x.example", { fetchImpl: res(200, "x".repeat(8 * 1024 * 1024 + 1)) }))).kind, "fatal");
  assert.equal((await kind(fetchJson("https://x.example", { fetchImpl: async () => { throw new TypeError("Failed to fetch"); } }))).kind, "transient");
});

test("fetchJson: caller cancellation and timeouts are distinguished", async () => {
  const hang = (_u, { signal }) => new Promise((_r, rej) => signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
  const ac = new AbortController();
  const p = kind(fetchJson("https://x.example", { fetchImpl: hang, signal: ac.signal }));
  setTimeout(() => ac.abort(), 10);
  assert.equal((await p).kind, "aborted");
  const pre = new AbortController();
  pre.abort();
  assert.equal((await kind(fetchJson("https://x.example", { fetchImpl: hang, signal: pre.signal }))).kind, "aborted");
  const t = await kind(fetchJson("https://x.example", { fetchImpl: hang, timeoutMs: 15 }));
  assert.equal(t.kind, "transient");
  assert.equal(t.code, "timeout");
});

// ================================================================== csv.js
test("parseCsv: quotes, doubled quotes, embedded newlines, CRLF/CR, BOM, blank lines", () => {
  const rows = parseCsv('﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n\r\n"multi\nline",2,3\r4,5,6\n');
  assert.deepEqual(rows, [["a", "b", "c"], ["1", "x, y", 'say "hi"'], ["multi\nline", "2", "3"], ["4", "5", "6"]]);
});

test("parseCsv: unbalanced quotes and over-limit input raise CsvError", () => {
  assert.throws(() => parseCsv('a,b\n"unterminated,1\n'), CsvError);
  assert.throws(() => parseCsv("a\n".repeat(20), { maxRows: 5 }), CsvError);
  assert.throws(() => parseCsv("1,".repeat(200), { maxColumns: 10 }), CsvError);
  assert.throws(() => parseCsv(`a\n${"x".repeat(50)}`, { maxFieldChars: 10 }), CsvError);
});

// ================================================================== file-import.js
const CSV = [
  "Job Title,Company Name,Location,Job URL,Description,Posted Date,Salary,Employment Type,Remote,Skills,Application Status,ID",
  'Product Designer,Acme,Berlin,https://jobs.acme.example/1,"<p>Design <b>things</b></p>",2026-10-01,"EUR 60,000",full time,hybrid,"Figma; Sketch",Open,A-1',
  "Data Analyst,Globex,,https://jobs.globex.example/2,Plain text,,,Contract,yes,sql,closed,",
].join("\r\n");

test("CSV import: aliases, normalisation and HTML stripping", () => {
  const r = parseImportFile({ name: "jobs.csv", text: CSV }, { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.format, "csv");
  assert.equal(r.records.length, 2);
  const [a, b] = r.records;
  assert.deepEqual([a.provider, a.externalId, a.title, a.company, a.location], ["file", "A-1", "Product Designer", "Acme", "Berlin"]);
  assert.equal(a.url, "https://jobs.acme.example/1");
  assert.equal(a.description, "Design things");
  assert.equal(a.postedDateApprox, "2026-10-01");
  assert.equal(a.employmentType, "Full-time");
  assert.equal(a.workplaceType, "Hybrid");
  assert.deepEqual(a.skills, ["figma", "sketch"]);
  assert.equal(a.applicationStatus, "open");
  assert.equal(a.salary, "EUR 60,000");
  assert.equal(b.workplaceType, "Remote", "boolean-ish remote column");
  assert.equal(b.applicationStatus, "closed");
  assert.match(b.externalId, /^url-[0-9a-f]{16}$/, "no id column value -> deterministic id from the URL");
  assert.equal(b.employmentType, "Contract");
});

test("CSV import: every record passes the database mapper (end to end)", () => {
  const r = parseImportFile({ name: "jobs.csv", text: CSV }, { now: NOW });
  for (const rec of r.records) {
    const { __canonical, ...clean } = rec; // eslint-disable-line no-unused-vars
    const m = toRow(clean);
    assert.equal(m.ok, true, JSON.stringify(m));
    assert.equal(m.row.provider, "file");
    assert.equal(m.row.linkedin_job_id, null);
  }
});

test("import: malformed records are reported individually; valid ones are kept", () => {
  const csv = [
    "title,url,company",
    "Good,https://ok.example/1,Acme",
    ",https://ok.example/2,NoTitle",
    "NoUrl,,Acme",
    "HttpUrl,http://insecure.example/3,Acme",
    "Script,javascript:alert(1),Acme",
    "Creds,https://user:pw@evil.example/4,Acme",
    "Space,https://ok.example/a b,Acme",
    "Another Good,https://ok.example/5,Acme",
  ].join("\n");
  const r = parseImportFile({ name: "x.csv", text: csv });
  assert.deepEqual(r.records.map((x) => x.title), ["Good", "Another Good"]);
  assert.equal(r.rejectedCount, 6);
  assert.deepEqual(r.rejected.map((x) => x.reason), ["missing-title", "missing-url", "invalid-url", "invalid-url", "invalid-url", "invalid-url"]);
  assert.deepEqual(r.rejected.map((x) => x.row), [2, 3, 4, 5, 6, 7]);
});

test("import: script/HTML/event handlers in any field are neutralised; formulas stay inert text", () => {
  const rows = [{ title: '<img src=x onerror="alert(1)">Dev<script>x()</script>', url: "https://ok.example/1", company: "<b>Acme</b>", description: "<script>steal()</script><p onclick=x()>Hi</p>", location: "<a href='javascript:1'>Here</a>", skills: ["<i>js</i>"] }, { title: "=HYPERLINK(\"http://evil\")", url: "https://ok.example/2" }];
  const r = parseImportFile({ name: "x.json", text: JSON.stringify(rows) });
  const [a, f] = r.records;
  assert.equal(a.title, "Dev");
  assert.equal(a.company, "Acme");
  assert.equal(a.description, "Hi");
  assert.equal(a.location, "Here");
  assert.deepEqual(a.skills, ["js"]);
  assert.doesNotMatch(JSON.stringify(a), /<|onerror=|onclick=|javascript:/i);
  assert.equal(f.title, '=HYPERLINK("http://evil")', "stored as plain text; the export neutralises formulas");
});

test("JSON import: array form and {jobs: []} form; invalid shapes and syntax are rejected clearly", () => {
  const job = { title: "T", url: "https://ok.example/1" };
  assert.equal(parseImportFile({ name: "a.json", text: JSON.stringify([job]) }).records.length, 1);
  assert.equal(parseImportFile({ name: "a.json", text: JSON.stringify({ jobs: [job] }) }).records.length, 1);
  assert.match(parseImportFile({ name: "a.json", text: "{not json" }).error, /not valid JSON/);
  assert.match(parseImportFile({ name: "a.json", text: '{"jobs": 5}' }).error, /array/);
  assert.match(parseImportFile({ name: "a.json", text: '"hello"' }).error, /array/);
  const mixed = parseImportFile({ name: "a.json", text: JSON.stringify([job, 5, null, "x", [1], { title: "No url" }]) });
  assert.equal(mixed.records.length, 1);
  assert.equal(mixed.rejectedCount, 5);
});

test("import: file type, size, emptiness and CSV structure are validated before parsing", () => {
  for (const name of ["a.txt", "a.exe", "noext", "a.csv.exe", "a.json.html", "", undefined]) {
    assert.match(parseImportFile({ name, text: "x" }).error, /Only \.csv and \.json/, String(name));
  }
  assert.match(parseImportFile({ name: "a.csv", text: "title,url\nA,https://x.example/1", size: FILE_LIMITS.maxBytes + 1 }).error, /larger than/);
  assert.match(parseImportFile({ name: "a.csv", text: "   \n " }).error, /empty/);
  assert.match(parseImportFile({ name: "a.csv", text: undefined }).error, /read as text/);
  assert.match(parseImportFile({ name: "a.csv", text: "title,url\n" }).error, /at least one job/);
  assert.match(parseImportFile({ name: "a.csv", text: "foo,bar\n1,2" }).error, /no recognised columns/);
  assert.match(parseImportFile({ name: "a.csv", text: 'title,url\n"oops,https://x.example' }).error, /quoted field/);
});

test("import: duplicates (by id or by URL) are collapsed before saving and counted", () => {
  const csv = ["id,title,url", "1,A,https://x.example/1", "1,A again,https://x.example/1b", ",B,https://x.example/2", ",B copy,https://x.example/2", "2,C,https://x.example/3"].join("\n");
  const r = parseImportFile({ name: "a.csv", text: csv });
  assert.deepEqual(r.records.map((x) => x.title), ["A", "B", "C"]);
  assert.equal(r.duplicates, 2);
});

test("import: record limits are configurable and capped; oversized fields are truncated", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ title: `T${i}`, url: `https://x.example/${i}`, description: "d".repeat(25000) }));
  const r = parseImportFile({ name: "a.json", text: JSON.stringify(rows) }, { maxRecords: 5 });
  assert.equal(r.records.length, 5);
  assert.equal(r.overLimit, 25);
  assert.equal(r.records[0].description.length, FILE_LIMITS.maxDescriptionChars);
  assert.equal(parseImportFile({ name: "a.json", text: JSON.stringify(rows) }, { maxRecords: 100000 }).records.length <= FILE_LIMITS.maxRecordsHard, true);
  assert.equal(parseImportFile({ name: "a.json", text: JSON.stringify(rows) }, { maxRecords: 0 }).records.length, 1, "a nonsensical limit still imports at least one record");
});

test("import: the raw file size limit stops oversized files before parsing", () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ title: `T${i}`, url: `https://x.example/${i}`, description: "d".repeat(19000) }));
  const text = JSON.stringify(rows);
  assert.ok(text.length > FILE_LIMITS.maxBytes);
  assert.match(parseImportFile({ name: "a.json", text }, { maxRecords: 200 }).error, /larger than/);
});

test("import: the serialized-record cap is a second safety net so a checkpoint can never overflow extension storage", () => {
  const records = Array.from({ length: 200 }, (_, i) => sanitizeRecord({ title: "t".repeat(500), company: "c".repeat(500), location: "l".repeat(500), url: `https://x.example/${i}`, description: "d".repeat(20000) }, NOW).record);
  assert.ok(JSON.stringify(records).length > FILE_LIMITS.maxPayloadChars);
  const v = createFileSource().validateParams({ records });
  assert.equal(v.ok, false);
  assert.match(v.errors[0], /too large/);
});

test("sanitizeRecord is idempotent on clean records (re-validation keeps date, status, skills)", () => {
  const first = sanitizeRecord({ title: "T", url: "https://x.example/1", postedDate: "2026-10-01", status: "open", skills: "a;b", workplaceType: "remote" }, NOW).record;
  const again = sanitizeRecord(first, NOW).record;
  assert.deepEqual(again, first);
  assert.equal(sanitizeRecord(null).reason, "not-an-object");
  assert.equal(sanitizeRecord([1]).reason, "not-an-object");
  assert.equal(sanitizeRecord({ title: "T", url: "https://x.example/1", postedDate: "2026-02-31" }).record.postedDateApprox, "", "impossible dates are dropped");
});

test("file source adapter: validates params, caps to maxJobs, pages by cursor, fetches details by index", async () => {
  const src = assertJobSource(createFileSource());
  const records = Array.from({ length: 7 }, (_, i) => sanitizeRecord({ title: `T${i}`, url: `https://x.example/${i}` }, NOW).record);
  assert.equal(src.validateParams({}).ok, false);
  assert.equal(src.validateParams({ records: [] }).ok, false);
  assert.equal(src.validateParams({ records: [{ title: "" }] }).ok, false);
  const v = src.validateParams({ records: [...records, { bad: true }, records[0]], fileName: "<b>my.csv</b>" }, { maxJobs: 5 });
  assert.equal(v.ok, true);
  assert.equal(v.params.records.length, 5, "capped at maxJobs, duplicates and invalid rows dropped");
  assert.equal(v.params.fileName, "my.csv");
  const p1 = await src.search(v.params, null, { pageSize: 3 });
  assert.equal(p1.refs.length, 3);
  assert.deepEqual(p1.nextCursor, { o: 3 });
  const p2 = await src.search(v.params, p1.nextCursor, { pageSize: 3 });
  assert.equal(p2.refs.length, 2);
  assert.equal(p2.nextCursor, null);
  const raw = await src.getDetails(p2.refs[0], { params: v.params });
  assert.equal(src.normalize(raw, p2.refs[0]).title, "T3");
  assert.ok(!("__canonical" in src.normalize(raw)));
  assert.equal(await src.getDetails({ externalId: "nope", index: 0 }, { params: v.params }), null);
  assert.equal(src.normalize(null), null);
  assert.deepEqual((await src.search(v.params, { o: -5 }, { pageSize: 2 })).refs.length, 2, "an invalid cursor restarts from the beginning");
});

// ================================================================== greenhouse.js
const detailFor = (ref) => ({ ...DETAIL, id: Number(ref), absolute_url: `https://boards.greenhouse.io/figma/jobs/${ref}` });
function ghFetch({ boards = { figma: LIST }, calls = [] } = {}) {
  return async (url) => {
    calls.push(url);
    const list = url.match(/\/boards\/([^/]+)\/jobs$/);
    if (list) {
      const b = decodeURIComponent(list[1]);
      if (b in boards) return boards[b];
      throw new SourceError("not-found", "Not found", { status: 404 });
    }
    const one = url.match(/\/boards\/([^/]+)\/jobs\/(\d+)\?pay_transparency=true$/);
    if (one) return detailFor(one[2]);
    throw new Error(`unexpected URL ${url}`);
  };
}
const gh = (opts, extra) => createGreenhouseSource({ fetchJson: ghFetch(opts), now: () => NOW.getTime(), ...extra });

test("greenhouse: board tokens are validated (no path tricks), de-duplicated, limited; keyword stripped of markup", () => {
  const s = gh();
  assert.equal(assertJobSource(s).id, "greenhouse");
  const ok = s.validateParams({ boards: [" figma ", "Figma", "gitlab", ""], keyword: " <b>designer</b> " });
  assert.deepEqual(ok.params, { boards: ["figma", "gitlab"], keyword: "designer" });
  for (const bad of ["../etc", "a/b", "a b", "a.b", "%2e%2e", "-x", "x".repeat(65), "figma?x=1", "figma#", "http://evil"]) {
    const r = s.validateParams({ boards: [bad] });
    assert.equal(r.ok, false, bad);
    assert.equal(BOARD_TOKEN_RE.test(bad), false, bad);
  }
  assert.equal(s.validateParams({ boards: [] }).ok, false);
  assert.equal(s.validateParams({}).ok, false);
  assert.equal(s.validateParams({ boards: Array.from({ length: 11 }, (_, i) => `b${i}`) }).ok, false);
});

test("greenhouse: the list is paged locally with an {board, offset} cursor (the API itself has no pagination)", async () => {
  const calls = [];
  const s = gh({ calls });
  const params = { boards: ["figma"], keyword: "" };
  const p1 = await s.search(params, null, { pageSize: 4 });
  assert.equal(p1.refs.length, 4);
  assert.deepEqual(p1.nextCursor, { b: 0, o: 4 });
  assert.equal(p1.total, 6);
  assert.deepEqual(p1.refs[0], { externalId: "figma:5426468004", board: "figma", id: "5426468004", title: LIST.jobs[0].title, url: LIST.jobs[0].absolute_url, updatedAt: LIST.jobs[0].updated_at });
  const p2 = await s.search(params, p1.nextCursor, { pageSize: 4 });
  assert.equal(p2.refs.length, 2);
  assert.equal(p2.nextCursor, null);
  assert.equal(calls.length, 1, "the board list was fetched once and cached for the second page");
  assert.deepEqual([...p1.refs, ...p2.refs].map((r) => r.id), LIST.jobs.map((j) => String(j.id)));
});

test("greenhouse: several boards are walked in order; a missing board warns and is skipped; the list cache expires", async () => {
  let t = NOW.getTime();
  const calls = [];
  const boards = { figma: { jobs: LIST.jobs.slice(0, 2), meta: { total: 2 } }, acme: { jobs: [{ id: 1, title: "Dev" }], meta: { total: 1 } } };
  const s = createGreenhouseSource({ fetchJson: ghFetch({ boards, calls }), now: () => t, listCacheMs: 1000 });
  const params = { boards: ["figma", "ghost", "acme"], keyword: "" };
  const seen = [];
  let cursor = null;
  const warnings = [];
  do {
    const p = await s.search(params, cursor, { pageSize: 5 });
    seen.push(...p.refs.map((r) => r.externalId));
    if (p.warnings) warnings.push(...p.warnings);
    cursor = p.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, [`figma:${LIST.jobs[0].id}`, `figma:${LIST.jobs[1].id}`, "acme:1"]);
  assert.deepEqual(warnings, ['Board "ghost" was not found on Greenhouse.']);
  const before = calls.length;
  await s.search({ boards: ["figma"], keyword: "" }, null, { pageSize: 5 });
  assert.equal(calls.length, before, "cache hit inside the TTL");
  t += 5000;
  await s.search({ boards: ["figma"], keyword: "" }, null, { pageSize: 5 });
  assert.equal(calls.length, before + 1, "refetched after the TTL");
});

test("greenhouse: keyword filters titles locally; empty boards and invalid cursors are handled", async () => {
  const s = gh();
  const kw = LIST.jobs[0].title.split(" ")[0].toLowerCase();
  const p = await s.search({ boards: ["figma"], keyword: kw }, null, { pageSize: 50 });
  assert.ok(p.refs.length >= 1 && p.refs.every((r) => r.title.toLowerCase().includes(kw)));
  assert.equal((await s.search({ boards: ["figma"], keyword: "zzzz-no-match" }, null, { pageSize: 5 })).refs.length, 0);
  assert.equal((await s.search({ boards: ["figma"], keyword: "" }, { b: 9, o: 0 }, { pageSize: 5 })).nextCursor, null);
  assert.equal((await s.search({ boards: ["figma"], keyword: "" }, { b: "x", o: -1 }, { pageSize: 2 })).refs.length, 2, "garbage cursor restarts safely");
});

test("greenhouse: malformed list responses raise a 'malformed' SourceError; bad entries are filtered out", async () => {
  const mk = (data) => createGreenhouseSource({ fetchJson: async () => data, now: () => NOW.getTime() });
  for (const bad of [null, "str", {}, { jobs: "x" }, { jobs: {} }]) {
    await assert.rejects(mk(bad).search({ boards: ["figma"], keyword: "" }, null, { pageSize: 5 }), (e) => e instanceof SourceError && e.kind === "malformed");
  }
  const p = await mk({ jobs: [null, 5, { id: "x", title: "no numeric id" }, { id: 7, title: 9 }, { id: 8, title: "good" }] }).search({ boards: ["b"], keyword: "" }, null, { pageSize: 10 });
  assert.deepEqual(p.refs.map((r) => r.id), ["8"]);
});

test("greenhouse: network and rate-limit errors from the list propagate unchanged for the controller to handle", async () => {
  const rl = createGreenhouseSource({ fetchJson: async () => { throw new SourceError("rate-limited", "slow", { retryAfterMs: 4000 }); }, now: () => NOW.getTime() });
  await assert.rejects(rl.search({ boards: ["figma"], keyword: "" }, null, { pageSize: 5 }), (e) => e.kind === "rate-limited" && e.retryAfterMs === 4000);
});

test("greenhouse: getDetails requests the documented URL and refuses unsafe references", async () => {
  const calls = [];
  const s = gh({ calls });
  const raw = await s.getDetails({ board: "figma", id: "5426468004" }, {});
  assert.equal(calls[0], "https://boards-api.greenhouse.io/v1/boards/figma/jobs/5426468004?pay_transparency=true");
  assert.equal(raw.id, 5426468004);
  for (const ref of [{ board: "../x", id: "1" }, { board: "figma", id: "1/../../x" }, { board: "figma", id: "abc" }, null, {}]) {
    await assert.rejects(s.getDetails(ref, {}), (e) => e instanceof SourceError && e.kind === "malformed");
  }
});

test("greenhouse: the real job detail normalises to the common model (plain-text description, pay, department, status)", () => {
  const s = gh();
  const rec = s.normalize(DETAIL, { board: "figma" });
  assert.equal(rec.provider, "greenhouse");
  assert.equal(rec.externalId, "figma:5426468004");
  assert.equal(rec.title, DETAIL.title);
  assert.equal(rec.company, "Figma");
  assert.equal(rec.location, DETAIL.location.name);
  assert.equal(rec.url, DETAIL.absolute_url);
  assert.equal(rec.postedDateApprox, "2025-01-28");
  assert.equal(rec.applicationStatus, "open");
  assert.deepEqual(rec.otherPills, ["Sales"]);
  assert.equal(rec.salary, "USD 165,000 - 190,000 (Annual Base Salary Range)");
  assert.equal(rec.source, "detail");
  assert.match(rec.description, /^Figma is growing our team/);
  assert.doesNotMatch(rec.description, /[<>]|&lt;|&gt;|&quot;|&amp;/, "no markup or entities remain");
  assert.match(rec.description, /\n- /, "list items kept as bullets");
  assert.ok(rec.description.length > 1000);
});

test("greenhouse: the normalised record is accepted by the database mapper (provider + https URL, no linkedin id)", () => {
  const m = toRow(gh().normalize(DETAIL, { board: "figma" }));
  assert.equal(m.ok, true, JSON.stringify(m));
  assert.deepEqual([m.row.provider, m.row.external_id, m.row.linkedin_job_id], ["greenhouse", "figma:5426468004", null]);
  assert.equal(m.row.application_status, "open");
  assert.equal(m.row.has_full_detail, true);
});

test("greenhouse: deadline in the past -> closed; remote/hybrid from the location; unsafe or missing URL falls back to the board URL", () => {
  const s = gh();
  const past = s.normalize({ ...DETAIL, application_deadline: "2026-01-01T00:00:00Z" }, { board: "figma" });
  assert.deepEqual([past.applicationStatus, past.applicationStatusText], ["closed", "Application deadline has passed"]);
  assert.equal(s.normalize({ ...DETAIL, application_deadline: "2027-01-01T00:00:00Z" }, { board: "figma" }).applicationStatus, "open");
  assert.equal(s.normalize({ ...DETAIL, location: { name: "Remote - US" } }, { board: "figma" }).workplaceType, "Remote");
  assert.equal(s.normalize({ ...DETAIL, location: { name: "London (Hybrid)" } }, { board: "figma" }).workplaceType, "Hybrid");
  assert.equal(s.normalize({ ...DETAIL, location: { name: "Berlin" } }, { board: "figma" }).workplaceType, "");
  for (const bad of ["javascript:alert(1)", "http://x.example/1", undefined, "not a url"]) {
    assert.equal(s.normalize({ ...DETAIL, absolute_url: bad }, { board: "figma" }).url, "https://boards.greenhouse.io/figma/jobs/5426468004");
  }
});

test("greenhouse: hostile content in a posting is neutralised; malformed records normalise to null", () => {
  const s = gh();
  const rec = s.normalize({ ...DETAIL, title: "<img src=x onerror=alert(1)>Designer", content: "&lt;script&gt;steal()&lt;/script&gt;&lt;p onclick=&quot;x()&quot;&gt;Join us&lt;/p&gt;", departments: [{ name: "<b>Sales</b>" }] }, { board: "figma" });
  assert.equal(rec.title, "Designer");
  assert.equal(rec.description, "Join us");
  assert.deepEqual(rec.otherPills, ["Sales"]);
  for (const bad of [null, undefined, 5, "x", {}, { id: 1 }, { id: 1, title: 5 }]) assert.equal(s.normalize(bad, { board: "figma" }), null);
});

// ================================================================== registry
test("registry exposes the two sources, rejects malformed sources, and returns null for unknown ids", () => {
  const reg = createSourceRegistry({ fetchJson: async () => ({}) });
  assert.deepEqual(reg.list().map((s) => s.id).sort(), ["file", "greenhouse"]);
  assert.equal(reg.get("greenhouse").id, "greenhouse");
  for (const bad of ["linkedin", "__proto__", "constructor", undefined, 5, null]) assert.equal(reg.get(bad), null, String(bad));
  assert.throws(() => assertJobSource({ id: "x1", search() {}, getDetails() {}, normalize() {}, heavyParams: [] }), /validateParams/);
  assert.throws(() => assertJobSource({ id: "Bad Id", validateParams() {}, search() {}, getDetails() {}, normalize() {}, heavyParams: [] }), /valid id/);
  assert.throws(() => assertJobSource({ id: "ok1", validateParams() {}, search() {}, getDetails() {}, normalize() {} }), /heavyParams/);
});
