// Cursor descriptions, import statistics, and the documented sample files.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFileSource, parseImportFile, sanitizeRecord } from "../src/sources/file-import.js";
import { createGreenhouseSource } from "../src/sources/greenhouse.js";
import { toRow } from "../src/db/job-mapper.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = new Date("2026-10-22T12:00:00Z");
const doc = (n) => fs.readFileSync(path.join(root, "docs", n), "utf8");

test("sources describe their cursor for the progress display", () => {
  const gh = createGreenhouseSource({ fetchJson: async () => ({}) });
  assert.equal(gh.describeCursor({ b: 1, o: 25 }, { boards: ["figma", "gitlab"] }), 'board "gitlab", from job 26');
  assert.equal(gh.describeCursor({ b: 9, o: 0 }, { boards: ["figma"] }), "");
  assert.equal(createFileSource().describeCursor({ o: 50 }), "from record 51");
});

test("file import statistics are display-only numbers and are sanitised", () => {
  const rec = sanitizeRecord({ title: "T", url: "https://x.example/1" }, NOW).record;
  const v = createFileSource().validateParams({ records: [rec], stats: { total: 7, valid: 1, invalid: -3, duplicatesInFile: "x", overLimit: 1e9, injected: "<b>" } });
  assert.deepEqual(v.params.stats, { total: 7, valid: 1, invalid: 0, duplicatesInFile: 0, overLimit: 0 });
  assert.equal(createFileSource().validateParams({ records: [rec] }).params.stats, null);
});

test("the documented JSON sample imports cleanly and every record is accepted by the database mapper", () => {
  const r = parseImportFile({ name: "sample-jobs.json", text: doc("sample-jobs.json") }, { now: NOW });
  assert.equal(r.ok, true);
  assert.deepEqual(r.records.map((x) => [x.externalId, x.employmentType, x.workplaceType]), [["EX-301", "Full-time", "Remote"], ["EX-302", "Contract", "Hybrid"]]);
  assert.deepEqual(r.records[1].skills, ["node", "postgres"]);
  assert.equal(r.records[0].description, "Build fast, accessible interfaces.");
  assert.equal(r.records[0].postedDateApprox, "2026-10-12");
  for (const rec of r.records) {
    const { __canonical, ...clean } = rec; // eslint-disable-line no-unused-vars
    assert.equal(toRow(clean).ok, true);
  }
});

test("the documented CSV samples parse exactly as the documentation says", () => {
  const ok = parseImportFile({ name: "sample-jobs.csv", text: doc("sample-jobs.csv") });
  assert.deepEqual([ok.records.length, ok.rejectedCount, ok.duplicates], [3, 0, 0]);
  const mixed = parseImportFile({ name: "sample-jobs-invalid.csv", text: doc("sample-jobs-invalid.csv") });
  assert.deepEqual([mixed.records.length, mixed.rejectedCount, mixed.duplicates], [2, 4, 1]);
  assert.deepEqual(mixed.rejected.map((x) => x.reason), ["missing-title", "missing-url", "invalid-url", "invalid-url"]);
});

test("the import format document lists every accepted alias the importer actually uses", () => {
  const md = doc("IMPORT_FORMAT.md");
  for (const alias of ["job title", "apply url", "external id", "company website", "date posted", "work mode", "experience required", "application status"]) {
    assert.ok(md.includes(alias), alias);
  }
  const r = parseImportFile({ name: "x.csv", text: "Job Title,Apply URL,External ID,Work Mode\nA,https://x.example/1,Z-9,remote" });
  assert.deepEqual([r.records[0].title, r.records[0].url, r.records[0].externalId, r.records[0].workplaceType], ["A", "https://x.example/1", "Z-9", "Remote"]);
});
