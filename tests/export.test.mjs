import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, strFromU8 } from "fflate";
import { EXPORT_COLUMNS, statusLabel } from "../src/export/columns.js";
import { toCsv, csvField, neutralizeFormula } from "../src/export/csv.js";
import { buildSheetData, xlsxBlob } from "../src/export/xlsx.js";
import { buildExport, downloadBlob, EXPORT_FORMATS, exportFileName, fetchAllJobs } from "../src/export/export-jobs.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const job = (over = {}) => ({
  id: "id-1", jobId: "4480218579", url: "https://www.linkedin.com/jobs/view/4480218579/", title: "Junior Graphic Designer",
  company: "YourfriendlyHR", companyUrl: "https://www.linkedin.com/company/yourfriendlyhr/", location: "India",
  workplaceType: "Remote", employmentType: "Full-time", applicationStatus: "closed", applicationStatusText: "No longer accepting applications",
  applicationStatusAt: "2026-10-22T10:00:00Z", postedText: "1 day ago", postedDateApprox: "2026-10-21", applicantsText: "Over 100 applicants",
  salary: "Up to ₹35,000/month", experience: "Fresher to Junior Level", skills: ["graphic design", "adobe"],
  responsibilities: ["Create graphics", "Develop concepts"], qualifications: ["Adobe CS"], description: "Line one\nLine two",
  source: "detail", hasFullDetail: true, collectedAt: "2026-10-21T12:00:00Z", createdAt: "2026-10-21T12:00:01Z", updatedAt: "2026-10-22T10:00:00Z",
  ...over,
});

// Minimal RFC 4180 parser used to check the CSV structurally.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r") { /* the \n that follows ends the row */ }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ------------------------------------------------------------------ columns
test("columns: Application status is a clear, early column; unknown is explicit", () => {
  const headers = EXPORT_COLUMNS.map((c) => c.header);
  assert.ok(headers.includes("Application status"));
  assert.ok(headers.includes("Application notice"));
  assert.ok(headers.indexOf("Application status") < headers.indexOf("Description"));
  assert.equal(new Set(headers).size, headers.length, "headers are unique");
  assert.deepEqual(["open", "closed", "", undefined, null, "pending"].map(statusLabel), ["Open", "Closed", "Unknown", "Unknown", "Unknown", "Unknown"]);
});

test("columns: missing, null and malformed values are exported as empty strings, never 'undefined' or 'null'", () => {
  for (const j of [{}, { skills: null, responsibilities: "x", title: null, company: undefined }, job({ skills: [null, "", "a"] })]) {
    for (const c of EXPORT_COLUMNS) {
      const v = c.get(j);
      assert.equal(typeof v, "string", c.key);
      assert.doesNotMatch(v, /undefined|null/, c.key);
    }
  }
  const get = (k, j) => EXPORT_COLUMNS.find((c) => c.key === k).get(j);
  assert.equal(get("skills", job()), "graphic design; adobe");
  assert.equal(get("responsibilities", job()), "Create graphics\nDevelop concepts");
  assert.equal(get("source", job({ source: "card", hasFullDetail: false })), "List card only");
  assert.equal(get("applicationStatus", {}), "Unknown");
});

// ------------------------------------------------------------------ CSV
test("csv: header row, BOM, CRLF, one line per job, same column count everywhere", () => {
  const csv = toCsv([job(), job({ id: "id-2", title: "Second" })]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.endsWith("\r\n"));
  const rows = parseCsv(csv.slice(1));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], EXPORT_COLUMNS.map((c) => c.header));
  assert.ok(rows.every((r) => r.length === EXPORT_COLUMNS.length));
  const h = rows[0];
  assert.equal(rows[1][h.indexOf("Application status")], "Closed");
  assert.equal(rows[1][h.indexOf("Application notice")], "No longer accepting applications");
  assert.equal(rows[2][h.indexOf("Job title")], "Second");
});

test("csv: commas, quotes and newlines round-trip; unicode is preserved", () => {
  const nasty = job({ title: 'He said "hi", then left', description: 'a,b\r\nc\n"d"', salary: "₹35,000" });
  const rows = parseCsv(toCsv([nasty]).slice(1));
  const h = rows[0];
  assert.equal(rows[1][h.indexOf("Job title")], 'He said "hi", then left');
  assert.equal(rows[1][h.indexOf("Description")], 'a,b\r\nc\n"d"');
  assert.equal(rows[1][h.indexOf("Salary")], "₹35,000");
});

test("csv: spreadsheet formulas are neutralised; ordinary text is untouched", () => {
  for (const evil of ['=HYPERLINK("http://x","y")', "+1+1", "-2+3", "@SUM(A1)", "\t=1", "\r=1"]) {
    assert.ok(neutralizeFormula(evil).startsWith("'"), JSON.stringify(evil));
  }
  for (const ok of ["Graphic Designer", "5 days ago", "₹35,000", "", "a=b"]) assert.equal(neutralizeFormula(ok), ok);
  const rows = parseCsv(toCsv([job({ title: "=cmd|' /C calc'!A0", company: "@evil" })]).slice(1));
  assert.equal(rows[1][rows[0].indexOf("Job title")][0], "'");
  assert.equal(rows[1][rows[0].indexOf("Company")][0], "'");
  assert.equal(csvField(null), "");
  assert.equal(csvField(undefined), "");
});

test("csv: empty export still has a header; tolerant of null entries", () => {
  assert.equal(parseCsv(toCsv([]).slice(1)).length, 1);
  assert.equal(parseCsv(toCsv([null, undefined]).slice(1)).length, 3);
  assert.equal(parseCsv(toCsv(undefined).slice(1)).length, 1);
});

// ------------------------------------------------------------------ XLSX
async function readXlsx(jobs) {
  const blob = await xlsxBlob(jobs);
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const text = {};
  for (const [name, bytes] of Object.entries(files)) if (/\.(xml|rels)$/.test(name)) text[name] = strFromU8(bytes);
  return { blob, files, text, all: Object.values(text).join("\n") };
}
const sheetXml = (x) => Object.entries(x.text).find(([n]) => /worksheets\/sheet1\.xml$/.test(n))[1];

test("xlsx: valid package with the headers, status values and a frozen header row", async () => {
  const x = await readXlsx([job(), job({ id: "id-2", applicationStatus: "open", applicationStatusText: "" }), job({ id: "id-3", applicationStatus: "" })]);
  assert.equal(x.blob.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.ok(x.files["[Content_Types].xml"] && x.files["xl/workbook.xml"]);
  assert.match(x.text["xl/workbook.xml"], /Saved jobs/);
  for (const c of EXPORT_COLUMNS) assert.ok(x.all.includes(c.header), c.header);
  for (const v of ["Closed", "Open", "Unknown", "No longer accepting applications", "Junior Graphic Designer"]) assert.ok(x.all.includes(v), v);
  assert.match(sheetXml(x), /<pane /, "header row is frozen");
  assert.equal((sheetXml(x).match(/<row /g) || []).length, 4, "header + 3 jobs");
});

test("xlsx: formula-looking text is stored as text, never as a formula", async () => {
  const x = await readXlsx([job({ title: "=1+1", company: "@SUM(A1)", description: '=HYPERLINK("http://x")' })]);
  assert.ok(!/<f[ >]/.test(x.all), "no <f> formula elements anywhere in the workbook");
  assert.ok(x.all.includes("=1+1"));
});

test("xlsx: empty values are blank cells, newlines survive, huge descriptions are truncated under Excel's cell limit", () => {
  const data = buildSheetData([job({ salary: "", description: "x".repeat(40000) }), job({ description: "a\nb" })]);
  assert.equal(data.length, 3);
  assert.ok(data.every((r) => r.length === EXPORT_COLUMNS.length));
  const h = EXPORT_COLUMNS.map((c) => c.key);
  assert.equal(data[1][h.indexOf("salary")], null);
  assert.ok(data[1][h.indexOf("description")].value.length < 32767);
  assert.match(data[1][h.indexOf("description")].value, /truncated\]$/);
  assert.equal(data[2][h.indexOf("description")].value, "a\nb");
  assert.equal(data[0][0].fontWeight, "bold");
});

test("xlsx: an empty export is still a valid workbook with just the header", async () => {
  const x = await readXlsx([]);
  assert.equal((sheetXml(x).match(/<row /g) || []).length, 1);
});

// ------------------------------------------------------------------ fetching, naming, formats
test("fetchAllJobs pages through everything with descriptions, passing the filters", async () => {
  const all = Array.from({ length: 450 }, (_, i) => ({ id: `id-${i}`, jobId: String(4400000000 + i) }));
  const calls = [];
  const fetchPage = async (args) => { calls.push(args); return { jobs: all.slice(args.offset, args.offset + args.limit), total: all.length }; };
  const progress = [];
  const out = await fetchAllJobs(fetchPage, { company: "Acme", applicationStatus: "closed" }, { onProgress: (a, b) => progress.push([a, b]) });
  assert.equal(out.length, 450);
  assert.deepEqual(calls.map((c) => c.offset), [0, 200, 400]);
  assert.ok(calls.every((c) => c.limit === 200 && c.includeDescription === true && c.company === "Acme" && c.applicationStatus === "closed"));
  assert.deepEqual(progress.at(-1), [450, 450]);
});

test("fetchAllJobs: empty library; de-duplicates shifting pages; honours the cap; propagates errors", async () => {
  assert.deepEqual(await fetchAllJobs(async () => ({ jobs: [], total: 0 })), []);
  let call = 0;
  const shifting = async () => {
    const shift = call++ ? 100 : 0;
    return { jobs: Array.from({ length: 200 }, (_, i) => ({ id: `id-${i + shift}` })), total: 400 };
  };
  const out = await fetchAllJobs(shifting);
  assert.equal(new Set(out.map((j) => j.id)).size, out.length, "no duplicates");
  const big = async (a) => ({ jobs: Array.from({ length: 200 }, (_, i) => ({ id: `id-${a.offset + i}` })), total: 100000 });
  assert.equal((await fetchAllJobs(big, {}, { maxRows: 500 })).length, 500);
  await assert.rejects(fetchAllJobs(async () => { throw new Error("boom"); }), /boom/);
});

test("export names and formats", async () => {
  const day = new Date("2026-10-22T08:00:00Z");
  assert.equal(exportFileName("csv", { now: day }), "linkedin-saved-jobs-2026-10-22.csv");
  assert.equal(exportFileName("xlsx", { filtered: true, now: day }), "linkedin-saved-jobs-2026-10-22-filtered.xlsx");
  assert.deepEqual(Object.keys(EXPORT_FORMATS).sort(), ["csv", "xlsx"]);
  assert.match((await buildExport([job()], "csv")).type, /text\/csv/);
  assert.match((await buildExport([job()], "xlsx")).type, /spreadsheetml/);
  await assert.rejects(buildExport([], "pdf"), /Unsupported/);
});

test("downloadBlob creates a link with the file name and cleans it up", () => {
  const clicks = [];
  const doc = { createElement: () => { const a = { click() { clicks.push(a); }, remove() { a.removed = true; } }; return a; }, body: { appendChild() {} } };
  const orig = URL.createObjectURL;
  URL.createObjectURL = () => "blob:test";
  try {
    downloadBlob(new Blob(["x"]), "f.csv", doc);
  } finally {
    URL.createObjectURL = orig;
  }
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].download, "f.csv");
  assert.equal(clicks[0].href, "blob:test");
  assert.equal(clicks[0].removed, true);
});

test("export is read-only: the export modules never reference any delete/update/save operation", () => {
  for (const f of ["columns.js", "csv.js", "xlsx.js", "export-jobs.js"]) {
    const src = fs.readFileSync(path.join(root, "src/export", f), "utf8");
    assert.doesNotMatch(src, /deleteJob|DELETE_JOB|updateJob|UPDATE_JOB|saveJobs|SAVE_JOBS|\.delete\(|\.update\(/, f);
  }
});

test("export: an imported row without a description is not described as 'Full details' or as a list card", () => {
  const get = (j) => EXPORT_COLUMNS.find((c) => c.key === "source").get(j);
  assert.equal(get({ provider: "file", source: "detail", hasFullDetail: false }), "Imported, no description");
  assert.equal(get({ provider: "file", source: "detail", hasFullDetail: true }), "Full details");
  assert.equal(get({ provider: "linkedin", source: "card", hasFullDetail: false }), "List card only");
  assert.equal(get({ source: "detail", hasFullDetail: false }), "Full details", "older LinkedIn rows keep their wording");
  const status = EXPORT_COLUMNS.find((c) => c.key === "extractionStatus").get;
  assert.equal(status({ provider: "file", source: "detail", hasFullDetail: false, extractionStatus: "partial" }), "Partial");
});
