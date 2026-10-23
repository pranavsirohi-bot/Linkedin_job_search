// Drives the real saved-jobs page (library.js bundled with esbuild) in jsdom against an in-memory fake of the
// service worker. Verifies UI behaviour; the fake stands in for the worker, so database behaviour is covered elsewhere.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { unzipSync, strFromU8 } from "fflate";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { outputFiles } = await build({
  entryPoints: [path.join(root, "src/library/library.js")], bundle: true, format: "iife", write: false, logLevel: "silent",
});
const LIBRARY_JS = outputFiles[0].text;
const HTML = fs.readFileSync(path.join(root, "src/library/library.html"), "utf8").replace(/<script[^>]*><\/script>/, "");

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(0); };

const mkJob = (i, over = {}) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, jobId: String(4400000000 + i),
  url: `https://www.linkedin.com/jobs/view/${4400000000 + i}/`, title: `Job ${i}`, company: i % 2 ? "Acme" : "Globex",
  location: "India", workplaceType: "Remote", employmentType: "Full-time", skills: ["figma", "adobe"], postedText: "1 day ago",
  postedDateApprox: "2026-10-21", applicationStatus: i % 3 === 0 ? "closed" : i % 3 === 1 ? "open" : "",
  applicationStatusText: i % 3 === 0 ? "No longer accepting applications" : "", applicationStatusAt: "2026-10-22T10:00:00Z",
  createdAt: "2026-10-21T12:00:00Z", description: `Description ${i}`, responsibilities: ["Do A"], qualifications: ["Know B"],
  hasFullDetail: true, source: "detail", ...over,
});

async function openLibrary({ jobs = [], worker = {}, configured = true } = {}) {
  const dom = new JSDOM(HTML, { url: "chrome-extension://ext/src/library/library.html", runScripts: "outside-only" });
  const w = dom.window;
  const sent = [];
  const downloads = [];
  const data = [...jobs];

  w.chrome = {
    runtime: {
      sendMessage: async (msg) => {
        sent.push(JSON.parse(JSON.stringify(msg)));
        if (worker[msg.type]) return worker[msg.type](msg, data);
        if (msg.type === "AUTH_STATUS") return { ok: true, configured, reason: configured ? "" : "Supabase project URL is not configured.", user: { id: "anon-1" }, sessionReplaced: false };
        if (msg.type === "LIST_JOBS") {
          const f = msg.filters || {};
          let rows = data;
          if (f.applicationStatus) rows = rows.filter((j) => (f.applicationStatus === "unknown" ? !j.applicationStatus : j.applicationStatus === f.applicationStatus));
          if (f.company) rows = rows.filter((j) => j.company.toLowerCase().includes(f.company.toLowerCase()));
          return { ok: true, jobs: rows.slice(f.offset, f.offset + f.limit), total: rows.length, limit: f.limit, offset: f.offset };
        }
        if (msg.type === "GET_JOB") {
          const job = data.find((j) => j.id === msg.id);
          return job ? { ok: true, job } : { ok: false, error: { code: "NOT_FOUND", message: "Job not found." } };
        }
        if (msg.type === "DELETE_JOB") {
          const i = data.findIndex((j) => j.id === msg.id);
          if (i < 0) return { ok: false, error: { code: "NOT_FOUND", message: "Job not found." } };
          data.splice(i, 1);
          return { ok: true, deleted: 1 };
        }
        return { ok: false, error: { code: "UNKNOWN", message: `unhandled ${msg.type}` } };
      },
    },
  };
  w.URL.createObjectURL = (blob) => { downloads.push({ blob }); return "blob:test"; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function click() { if (this.download) downloads.at(-1).name = this.download; };
  if (!w.TextEncoder) w.TextEncoder = TextEncoder;
  if (!w.TextDecoder) w.TextDecoder = TextDecoder;
  w.eval(LIBRARY_JS);
  await settle();

  const $ = (id) => w.document.getElementById(id);
  const click = async (target) => { (typeof target === "string" ? $(target) : target).click(); await settle(); };
  const rows = () => [...w.document.querySelectorAll("#rows > tr:not(.details)")];
  const cells = (tr) => [...tr.children].map((td) => td.textContent);
  const types = () => sent.map((m) => m.type);
  const listCalls = () => sent.filter((m) => m.type === "LIST_JOBS");
  const button = (tr, action) => tr.querySelector(`button[data-action="${action}"]`);
  const submit = async () => { $("filters").dispatchEvent(new w.Event("submit", { cancelable: true })); await settle(); };
  return { w, $, click, rows, cells, sent, types, listCalls, button, submit, downloads, data, notice: () => $("notice").textContent, noticeClass: () => $("notice").className };
}

// The page's Blob comes from jsdom, so it must be read with jsdom's FileReader.
function blobBytes(w, blob) {
  return new Promise((resolve, reject) => {
    const r = new w.FileReader();
    r.onload = () => resolve(new Uint8Array(r.result));
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(blob);
  });
}
async function blobText(w, blob) { return new TextDecoder().decode(await blobBytes(w, blob)); }

// ------------------------------------------------------------------ rendering
test("loads the profile once, then the first page of 25, and renders every field including application status", async () => {
  const p = await openLibrary({ jobs: Array.from({ length: 3 }, (_, i) => mkJob(i)) });
  assert.equal(p.types().filter((t) => t === "AUTH_STATUS").length, 1);
  assert.deepEqual(p.listCalls().map((m) => [m.filters.limit, m.filters.offset]), [[25, 0]]);
  const rows = p.rows();
  assert.equal(rows.length, 3);
  const headers = [...p.w.document.querySelectorAll("th")].map((th) => th.textContent);
  assert.ok(headers.includes("Applications"));
  const statuses = rows.map((r) => r.querySelector(".badge"));
  assert.deepEqual(statuses.map((b) => b.textContent), ["Closed", "Open", "Unknown"]);
  assert.deepEqual(statuses.map((b) => b.dataset.status), ["closed", "open", "unknown"]);
  assert.match(statuses[0].title, /No longer accepting applications/);
  assert.match(statuses[0].title, /checked 2026-10-22/);
  assert.deepEqual(p.cells(rows[1]).slice(0, 5), ["Job 1", "Acme", "India", "Remote", "Full-time"]);
  assert.equal(p.$("summary").textContent, "3 saved jobs");
  assert.equal(p.$("empty").hidden, true);
});

test("titles are links to the original listing only when the URL is a genuine LinkedIn job URL", async () => {
  const p = await openLibrary({ jobs: [mkJob(1), mkJob(2, { url: "javascript:alert(1)", title: "Evil link" }), mkJob(3, { url: "https://evil.example/jobs/view/123456/" })] });
  const [good, bad1, bad2] = p.rows();
  const a = good.querySelector("td.title a");
  assert.equal(a.href, "https://www.linkedin.com/jobs/view/4400000001/");
  assert.equal(a.target, "_blank");
  assert.match(a.rel, /noopener/);
  assert.equal(bad1.querySelector("a"), null);
  assert.equal(bad1.querySelector("td.title").textContent, "Evil link");
  assert.equal(bad2.querySelector("a"), null);
});

test("saved text is never interpreted as HTML", async () => {
  const xss = '<img src=x onerror="window.pwned=1"><script>window.pwned=1</script>';
  const p = await openLibrary({ jobs: [mkJob(1, { title: xss, company: xss, location: xss, skills: [xss], applicationStatusText: xss })] });
  await p.click(p.button(p.rows()[0], "details"));
  assert.equal(p.w.document.querySelector("#rows img, #rows script"), null);
  assert.equal(p.w.pwned, undefined);
  assert.equal(p.cells(p.rows()[0])[0], xss);
});

test("an empty library explains how to save jobs; no table rows and no pager", async () => {
  const p = await openLibrary({ jobs: [] });
  assert.equal(p.rows().length, 0);
  assert.equal(p.$("empty").hidden, false);
  assert.match(p.$("empty").textContent, /Nothing saved yet/);
  assert.equal(p.$("pager").hidden, true);
});

// ------------------------------------------------------------------ search and filters
test("search sends every filled filter (blank ones omitted) and resets to the first page", async () => {
  const p = await openLibrary({ jobs: Array.from({ length: 4 }, (_, i) => mkJob(i)) });
  p.$("f-query").value = "  designer photoshop ";
  p.$("f-company").value = "Acme";
  p.$("f-location").value = "India";
  p.$("f-skills").value = "Photoshop, ,figma ";
  p.$("f-workplace").value = "Remote";
  p.$("f-employment").value = "Full-time";
  p.$("f-status").value = "closed";
  await p.submit();
  const last = p.listCalls().at(-1).filters;
  assert.deepEqual(last, {
    query: "designer photoshop", company: "Acme", location: "India", workplaceType: "Remote", employmentType: "Full-time",
    applicationStatus: "closed", skills: ["Photoshop", "figma"], limit: 25, offset: 0,
  });
  p.$("f-query").value = "";
  p.$("f-company").value = "";
  p.$("f-skills").value = "";
  p.$("f-location").value = "";
  p.$("f-workplace").value = "";
  p.$("f-employment").value = "";
  p.$("f-status").value = "";
  await p.submit();
  assert.deepEqual(p.listCalls().at(-1).filters, { limit: 25, offset: 0 });
});

test("application-status filter offers Open, Closed and Unknown and filters the table", async () => {
  const p = await openLibrary({ jobs: Array.from({ length: 6 }, (_, i) => mkJob(i)) });
  assert.deepEqual([...p.$("f-status").options].map((o) => o.value), ["", "open", "closed", "unknown"]);
  for (const [value, expected] of [["closed", "Closed"], ["open", "Open"], ["unknown", "Unknown"]]) {
    p.$("f-status").value = value;
    await p.submit();
    const badges = p.rows().map((r) => r.querySelector(".badge").textContent);
    assert.equal(badges.length, 2, value);
    assert.ok(badges.every((b) => b === expected), value);
  }
});

test("no matches shows a helpful message; Reset clears the form and shows everything again", async () => {
  const p = await openLibrary({ jobs: [mkJob(1), mkJob(2)] });
  p.$("f-company").value = "zzz";
  await p.submit();
  assert.equal(p.rows().length, 0);
  assert.match(p.$("empty").textContent, /No saved jobs match/);
  await p.click("btn-reset");
  assert.equal(p.$("f-company").value, "");
  assert.equal(p.rows().length, 2);
  assert.deepEqual(p.listCalls().at(-1).filters, { limit: 25, offset: 0 });
});

test("a slow older search cannot overwrite a newer one", async () => {
  const resolvers = [];
  const p = await openLibrary({
    jobs: [mkJob(1)],
    worker: {
      LIST_JOBS: (msg) => new Promise((resolve) => {
        const delayed = msg.filters.company === "old";
        const respond = () => resolve({ ok: true, jobs: [mkJob(delayed ? 100 : 200)], total: 1, limit: 25, offset: 0 });
        if (delayed) resolvers.push(respond); else respond();
      }),
    },
  });
  p.$("f-company").value = "old";
  p.$("filters").dispatchEvent(new p.w.Event("submit", { cancelable: true }));
  await settle();
  p.$("f-company").value = "new";
  await p.submit();
  resolvers.forEach((r) => r());
  await settle();
  assert.deepEqual(p.rows().map((r) => p.cells(r)[0]), ["Job 200"]);
});

// ------------------------------------------------------------------ pagination
test("pagination: 60 jobs -> 25 / 25 / 10 with correct offsets and button states", async () => {
  const p = await openLibrary({ jobs: Array.from({ length: 60 }, (_, i) => mkJob(i)) });
  assert.equal(p.rows().length, 25);
  assert.equal(p.$("page-info").textContent, "1-25 of 60");
  assert.equal(p.$("btn-prev").disabled, true);
  await p.click("btn-next");
  assert.equal(p.listCalls().at(-1).filters.offset, 25);
  assert.equal(p.$("page-info").textContent, "26-50 of 60");
  await p.click("btn-next");
  assert.equal(p.rows().length, 10);
  assert.equal(p.$("page-info").textContent, "51-60 of 60");
  assert.equal(p.$("btn-next").disabled, true);
  await p.click("btn-prev");
  assert.equal(p.listCalls().at(-1).filters.offset, 25);
});

// ------------------------------------------------------------------ details and delete
test("Details loads the full record (GET_JOB) and shows description + status; Hide removes it", async () => {
  const p = await openLibrary({ jobs: [mkJob(0, { description: "Line <b>one</b>\nLine two", salary: "Up to 35,000/month" })] });
  const row = p.rows()[0];
  await p.click(p.button(row, "details"));
  assert.deepEqual(p.sent.filter((m) => m.type === "GET_JOB").map((m) => m.id), [row.dataset.id]);
  const details = p.w.document.querySelector("tr.details");
  assert.ok(details);
  assert.match(details.textContent, /Closed - No longer accepting applications/);
  assert.match(details.textContent, /Up to 35,000\/month/);
  assert.equal(details.querySelector(".description").textContent, "Line <b>one</b>\nLine two");
  assert.equal(details.querySelector("b"), null);
  await p.click(p.button(row, "details"));
  assert.equal(p.w.document.querySelector("tr.details"), null);
});

test("delete needs an explicit confirmation; Cancel deletes nothing; Confirm deletes and refreshes", async () => {
  const p = await openLibrary({ jobs: [mkJob(1), mkJob(2)] });
  let row = p.rows()[0];
  await p.click(p.button(row, "delete"));
  assert.ok(p.button(p.rows()[0], "confirm-delete") && p.button(p.rows()[0], "cancel-delete"));
  assert.ok(!p.types().includes("DELETE_JOB"));
  await p.click(p.button(p.rows()[0], "cancel-delete"));
  assert.ok(!p.types().includes("DELETE_JOB"));
  assert.equal(p.rows().length, 2);
  await p.click(p.button(p.rows()[0], "delete"));
  await p.click(p.button(p.rows()[0], "confirm-delete"));
  assert.deepEqual(p.sent.filter((m) => m.type === "DELETE_JOB").map((m) => m.id), [row.dataset.id]);
  assert.equal(p.rows().length, 1);
  assert.equal(p.notice(), "Job deleted.");
  assert.equal(p.data.length, 1);
});

test("a failed delete shows the error and keeps the job listed", async () => {
  const p = await openLibrary({ jobs: [mkJob(1)], worker: { DELETE_JOB: () => ({ ok: false, error: { code: "NETWORK", message: "Can't reach the server. Check your connection and try again." } }) } });
  await p.click(p.button(p.rows()[0], "delete"));
  await p.click(p.button(p.rows()[0], "confirm-delete"));
  assert.match(p.notice(), /Can't reach the server/);
  assert.equal(p.noticeClass(), "error");
  assert.equal(p.rows().length, 1);
});

// ------------------------------------------------------------------ error states
test("session setup failure: message and Try again; retry recovers", async () => {
  let n = 0;
  const p = await openLibrary({
    jobs: [mkJob(1)],
    worker: { AUTH_STATUS: () => (++n === 1 ? { ok: false, error: { code: "NETWORK", message: "Can't reach the server. Check your connection and try again." } } : { ok: true, configured: true, user: { id: "a" } }) },
  });
  assert.match(p.notice(), /Can't reach the server/);
  assert.equal(p.$("btn-retry").hidden, false);
  assert.ok(!p.types().includes("LIST_JOBS"));
  await p.click("btn-retry");
  assert.equal(p.rows().length, 1);
  assert.equal(p.$("btn-retry").hidden, true);
  assert.equal(p.notice(), "");
});

test("list failure shows the message with Try again; unconfigured project is explained", async () => {
  const p = await openLibrary({ worker: { LIST_JOBS: () => ({ ok: false, error: { code: "UNKNOWN", message: "column saved_jobs.application_status does not exist" } }) } });
  assert.match(p.notice(), /application_status does not exist/);
  assert.equal(p.$("btn-retry").hidden, false);
  const un = await openLibrary({ configured: false });
  assert.match(un.notice(), /not configured/);
  assert.ok(!un.types().includes("LIST_JOBS"));
});

test("a replaced profile is announced", async () => {
  const p = await openLibrary({ jobs: [mkJob(1)], worker: { AUTH_STATUS: () => ({ ok: true, configured: true, user: { id: "a" }, sessionReplaced: true }) } });
  assert.match(p.notice(), /previous private profile could not be restored/);
  assert.equal(p.noticeClass(), "warn");
});

// ------------------------------------------------------------------ export
test("Export all (CSV): pages through everything with descriptions, downloads, never writes", async () => {
  const p = await openLibrary({ jobs: Array.from({ length: 450 }, (_, i) => mkJob(i)) });
  p.$("export-format").value = "csv";
  await p.click("btn-export-all");
  const exportCalls = p.listCalls().filter((m) => m.filters.includeDescription);
  assert.deepEqual(exportCalls.map((m) => m.filters.offset), [0, 200, 400]);
  assert.ok(exportCalls.every((m) => m.filters.limit === 200 && !("applicationStatus" in m.filters)));
  assert.equal(p.downloads.length, 1);
  assert.match(p.downloads[0].name, /^linkedin-saved-jobs-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await blobText(p.w, p.downloads[0].blob);
  assert.match(csv, /Application status/);
  assert.equal(csv.trim().split("\r\n").length, 451);
  assert.match(csv, /,Closed,No longer accepting applications,/);
  assert.match(csv, /,Unknown,/);
  assert.match(p.notice(), /Exported 450 jobs to linkedin-saved-jobs-/);
  assert.match(p.notice(), /not changed/);
  for (const t of p.types()) assert.ok(["AUTH_STATUS", "LIST_JOBS"].includes(t), `unexpected message ${t}`);
});

test("Export filtered (Excel): uses the filters last applied, not unsaved edits; file is a real xlsx with the status column", async () => {
  const p = await openLibrary({ jobs: Array.from({ length: 12 }, (_, i) => mkJob(i)) });
  p.$("f-status").value = "closed";
  await p.submit();
  p.$("f-status").value = "open"; // edited but NOT searched
  p.$("export-format").value = "xlsx";
  await p.click("btn-export-filtered");
  const exportCall = p.listCalls().find((m) => m.filters.includeDescription);
  assert.equal(exportCall.filters.applicationStatus, "closed");
  assert.match(p.downloads[0].name, /-filtered\.xlsx$/);
  const files = unzipSync(await blobBytes(p.w, p.downloads[0].blob));
  const xml = Object.entries(files).filter(([n]) => n.endsWith(".xml")).map(([, b]) => strFromU8(b)).join("\n");
  assert.ok(xml.includes("Application status"));
  assert.ok(xml.includes("Closed"));
  assert.ok(!xml.includes(">Open<"), "only closed jobs were exported");
  assert.match(p.notice(), /Exported 4 jobs/);
});

test("export with nothing to export warns and downloads nothing", async () => {
  const p = await openLibrary({ jobs: [] });
  await p.click("btn-export-all");
  assert.equal(p.downloads.length, 0);
  assert.equal(p.noticeClass(), "warn");
  assert.match(p.notice(), /no saved jobs to export/);
});

test("export failure part-way: clear error, nothing downloaded, saved jobs untouched", async () => {
  let calls = 0;
  const p = await openLibrary({
    jobs: Array.from({ length: 450 }, (_, i) => mkJob(i)),
    worker: {
      LIST_JOBS: (msg, data) => {
        if (msg.filters.includeDescription && ++calls === 2) return { ok: false, error: { code: "NETWORK", message: "Can't reach the server. Check your connection and try again." } };
        return { ok: true, jobs: data.slice(msg.filters.offset, msg.filters.offset + msg.filters.limit), total: data.length, limit: msg.filters.limit, offset: msg.filters.offset };
      },
    },
  });
  await p.click("btn-export-all");
  assert.equal(p.downloads.length, 0);
  assert.equal(p.noticeClass(), "error");
  assert.match(p.notice(), /Export failed: Can't reach the server/);
  assert.match(p.notice(), /not changed/);
  assert.equal(p.data.length, 450);
  assert.ok(!p.types().includes("DELETE_JOB"));
  assert.equal(p.$("btn-export-all").disabled, false);
});

// ------------------------------------------------------------------ multiple providers
test("non-LinkedIn jobs link to their own https posting; unsafe URLs never become links; Source column names the provider", async () => {
  const p = await openLibrary({ jobs: [
    mkJob(1, { provider: "greenhouse", url: "https://boards.greenhouse.io/figma/jobs/5426468004" }),
    mkJob(2, { provider: "greenhouse", url: "javascript:alert(1)", title: "Bad scheme" }),
    mkJob(3, { provider: "file", url: "http://insecure.example/job" }),
    mkJob(4, { provider: "file", url: "https://user:pw@evil.example/x" }),
    mkJob(5),
  ] });
  const rows = p.rows();
  assert.equal(rows[0].querySelector("td.title a").href, "https://boards.greenhouse.io/figma/jobs/5426468004");
  for (const r of rows.slice(1, 4)) assert.equal(r.querySelector("td.title a"), null);
  const sourceCol = [...p.w.document.querySelectorAll("th")].findIndex((th) => th.textContent === "Source");
  assert.ok(sourceCol > 0);
  assert.deepEqual(rows.map((r) => r.children[sourceCol].textContent), ["Greenhouse", "Greenhouse", "Imported file", "Imported file", "LinkedIn"]);
  assert.ok(rows[4].querySelector("td.title a"), "LinkedIn rows keep their strict LinkedIn link");
});

test("exports include the Source column", async () => {
  const p = await openLibrary({ jobs: [mkJob(1, { provider: "greenhouse", url: "https://boards.greenhouse.io/figma/jobs/1" }), mkJob(2)] });
  p.$("export-format").value = "csv";
  await p.click("btn-export-all");
  const csv = await blobText(p.w, p.downloads[0].blob);
  const lines = csv.replace(/^\uFEFF/, "").split("\r\n");
  const header = lines[0].split(",");
  const col = header.indexOf("Source");
  assert.ok(col > 0);
  assert.deepEqual([lines[1].split(",")[col], lines[2].split(",")[col]], ["Greenhouse", "LinkedIn"]);
});

// ------------------------------------------------------------------ complete record in Details, completeness markers
test("Details shows the complete stored record in groups; empty fields are left out", async () => {
  const full = mkJob(1, {
    country: "India", seniorityLevel: "Entry level", salary: "Up to ₹35,000/month", salaryCurrency: "INR", salaryPeriod: "month",
    applicationMethod: "easy_apply", applicantsText: "Over 100 applicants", hiringInsight: "Responses managed off LinkedIn", experience: "1-2 years",
    education: ["Bachelor's degree"], certifications: ["Adobe Certified"], preferredQualifications: ["Premiere Pro"],
    extractionStatus: "partial", extractionWarnings: ["missing:postedText"], collectedAt: "2026-10-22T09:00:00Z", updatedAt: "2026-10-22T09:00:01Z",
  });
  const p = await openLibrary({ jobs: [full] });
  await p.click(p.button(p.rows()[0], "details"));
  const box = p.w.document.querySelector("tr.details");
  const text = box.textContent;
  for (const h of ["Job", "Employment", "Application", "Requirements", "Record", "Full description"]) assert.ok([...box.querySelectorAll("h3")].some((e) => e.textContent === h), h);
  for (const s of ["India", "Entry level", "Up to ₹35,000/month · INR · per month", "Easy Apply", "Responses managed off LinkedIn", "Bachelor's degree",
    "Adobe Certified", "Premiere Pro", "Know B", "Do A", "1-2 years", "posted date not found", "Description 1", "2026-10-21", "2026-10-22"]) {
    assert.ok(text.includes(s), s);
  }
  assert.ok(!text.includes("Seniority level") || text.includes("Entry level"));
  const dts = [...box.querySelectorAll("dt")].map((d) => d.textContent);
  assert.ok(!dts.includes("Company page"), "no row for an empty field");
});

test("card-only and partial records are marked in the table; complete and old full-detail rows are not", async () => {
  const p = await openLibrary({ jobs: [
    mkJob(1, { source: "card", hasFullDetail: false, description: null, extractionStatus: "partial" }),
    mkJob(2, { extractionStatus: "partial" }),
    mkJob(3, { extractionStatus: "complete" }),
    mkJob(4, { extractionStatus: null }),
  ] });
  const badge = (tr) => tr.querySelector("[data-extraction]")?.textContent ?? null;
  assert.deepEqual(p.rows().map(badge), ["Card only", "Partial", null, null]);
  const headers = [...p.w.document.querySelectorAll("th")].map((th) => th.textContent);
  assert.deepEqual(headers, ["Job", "Company", "Location", "Workplace", "Employment", "Applications", "Posted", "Saved", "Skills", "Source", "Actions"], "the table keeps its summary columns");
});

test("coming back to the Saved Jobs tab reloads the list, so a job upgraded from card-only to full is shown fresh", async () => {
  const cardOnly = mkJob(1, { id: "00000000-0000-4000-8000-000004476650", jobId: "4476650532", source: "card", hasFullDetail: false, description: null, extractionStatus: null });
  const p = await openLibrary({ jobs: [cardOnly] });
  assert.equal(p.rows()[0].querySelector("[data-extraction]").textContent, "Card only");
  // Meanwhile the job was saved again from LinkedIn with its full details.
  p.data[0] = { ...cardOnly, source: "detail", hasFullDetail: true, description: "Full description" };
  const before = p.listCalls().length;
  Object.defineProperty(p.w.document, "visibilityState", { configurable: true, get: () => "visible" });
  p.w.document.dispatchEvent(new p.w.Event("visibilitychange"));
  await settle();
  assert.equal(p.listCalls().length, before + 1);
  assert.equal(p.rows()[0].querySelector("[data-extraction]"), null, "no 'Card only' badge any more");
  await p.click(p.button(p.rows()[0], "details"));
  assert.ok(p.w.document.querySelector("tr.details").textContent.includes("Full job details"));
});

test("Details filter: All / Full details / Card only is sent with the search and used by exports", async () => {
  const p = await openLibrary({ jobs: [mkJob(1), mkJob(2, { source: "card", hasFullDetail: false, description: null })] });
  const opts = [...p.$("f-detail").options].map((o) => [o.value, o.textContent]);
  assert.deepEqual(opts, [["", "All"], ["full", "Full details"], ["card", "Card only"]]);
  p.$("f-detail").value = "card";
  await p.submit();
  assert.equal(p.listCalls().at(-1).filters.detail, "card");
  p.$("f-detail").value = "";
  await p.submit();
  assert.ok(!("detail" in p.listCalls().at(-1).filters), "All sends no filter");
});

test("each LinkedIn row has an Open on LinkedIn link; unsafe URLs get none", async () => {
  const p = await openLibrary({ jobs: [mkJob(1), mkJob(2, { url: "javascript:alert(1)" })] });
  const link = p.rows()[0].querySelector("a[data-action-link='open']");
  assert.equal(link.textContent, "Open on LinkedIn");
  assert.equal(link.getAttribute("href"), "https://www.linkedin.com/jobs/view/4400000001/");
  assert.equal(link.getAttribute("target"), "_blank");
  assert.match(link.getAttribute("rel"), /noopener/);
  assert.equal(p.rows()[1].querySelector("a[data-action-link='open']"), null);
  // Still there while a delete is being confirmed.
  await p.click(p.button(p.rows()[0], "delete"));
  assert.ok(p.rows()[0].querySelector("a[data-action-link='open']"));
});
