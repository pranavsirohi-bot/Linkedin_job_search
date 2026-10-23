// Multi-layout tests. Fixtures are trimmed copies of markup pasted from the live site (search-results panel and
// standalone /jobs/view/ page); modified variants are SYNTHETIC. Passing here does not prove live compatibility.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

require("../src/extract/xpath-selectors.js");
require("../src/extract/normalize.js");
require("../src/extract/extractor.js");
const { extractor, selectors } = globalThis.LJS;

const SA_URL = "https://www.linkedin.com/jobs/view/4480218579/";
const SR_URL = "https://www.linkedin.com/jobs/search-results/?currentJobId=4480307941";
const NOW = new Date("2026-10-21T12:00:00Z");
const html = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const load = (name, url = SA_URL) => new JSDOM(html(name), { url }).window.document;
const xp = (doc, xpath, ctx) => doc.evaluate(xpath, ctx || doc, null, 9, null).singleNodeValue;
const detail = (doc, url = SA_URL) => extractor.extractDetail(doc, NOW, url);

test("layout detection is URL based", () => {
  assert.equal(extractor.detectLayout("https://www.linkedin.com/jobs/view/4480218579/?x=1"), "standalone-job");
  assert.equal(extractor.detectLayout("https://www.linkedin.com/jobs/search-results/?currentJobId=1"), "search-results");
  assert.equal(extractor.detectLayout("https://www.linkedin.com/jobs/collections/recommended/"), "search-results");
  assert.equal(extractor.detectLayout("https://www.linkedin.com/company/capgemini/"), "unsupported");
  assert.equal(extractor.detectLayout("not a url"), "unsupported");
});

test("standalone: every header field comes from the header-anchored selectors", () => {
  const r = detail(load("job-standalone.html"));
  assert.equal(r.reason, "ok");
  assert.equal(r.layout, "standalone-job");
  const j = r.job;
  assert.equal(j.jobId, "4480218579");
  assert.equal(j.url, "https://www.linkedin.com/jobs/view/4480218579/");
  assert.equal(j.title, "Junior Graphic Designer");
  assert.equal(j.company, "YourfriendlyHR");
  assert.equal(j.companyUrl, "https://www.linkedin.com/company/yourfriendlyhr/");
  assert.equal(j.location, "India");
  assert.equal(j.postedText, "1 day ago");
  assert.equal(j.postedDateApprox, "2026-10-20");
  assert.equal(j.applicantsText, "Over 100 applicants");
  assert.equal(j.workplaceType, "Remote");
  assert.equal(j.employmentType, "Full-time");
  assert.deepEqual(r.failed, []);
  for (const f of ["title", "location", "postedText", "applicantsText", "workplaceType", "employmentType"]) {
    assert.equal(r.sources[f], "header-anchored", f);
  }
});

test("standalone: description from About section only; heuristics see the real posting", () => {
  const j = detail(load("job-standalone.html")).job;
  assert.match(j.description, /^One of our client is looking for a creative/);
  assert.match(j.description, /\n- Compensation: Up to ₹35,000\/month/);
  assert.doesNotMatch(j.description, /… ?more/);
  assert.doesNotMatch(j.description, /missing some required|Show match details|About the job/);
  assert.equal(j.salary, "Up to ₹35,000/month");
  assert.equal(j.experience, "Fresher to Junior Level");
  assert.deepEqual(j.skills, ["graphic design", "design", "adobe", "aesthetics", "adobe creative suite"]);
  assert.ok(j.responsibilities.includes("Develop creative concepts based on briefs."));
  assert.ok(j.qualifications.includes("Good understanding of typography, layouts and colour combinations."));
  assert.ok(!j.qualifications.some((l) => /Screening Round|selection process/.test(l)), "stops at Hiring Process");
});

test("standalone: title is the header <p>, never a heading or the match card text", () => {
  const doc = load("job-standalone.html");
  doc.querySelector("h2").textContent = "Totally different heading";
  const j = detail(doc).job;
  assert.equal(j.title, "Junior Graphic Designer");
  assert.doesNotMatch(JSON.stringify(j), /Totally different|Show match details|are missing some/);
});

test("standalone: exact live nesting <a><div><p><a>text</a></p></div></a> (built with DOM calls)", () => {
  const doc = load("job-standalone.html");
  const row = xp(doc, "//div[button[@aria-label='More options']]");
  const wrap = row.firstElementChild;
  while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
  const outer = doc.createElement("a");
  outer.setAttribute("href", "https://www.linkedin.com/company/yourfriendlyhr/life/");
  const div = doc.createElement("div");
  const p = doc.createElement("p");
  const inner = doc.createElement("a");
  inner.setAttribute("href", "https://www.linkedin.com/company/yourfriendlyhr/life/");
  inner.textContent = "YourfriendlyHR";
  p.appendChild(inner); div.appendChild(p); outer.appendChild(div); wrap.appendChild(outer);
  const r = detail(doc);
  assert.equal(r.job.company, "YourfriendlyHR");
  assert.equal(r.job.title, "Junior Graphic Designer");
  assert.equal(r.job.workplaceType, "Remote");
});

test("search-results: primary selectors still win and are reported", () => {
  const r = detail(load("job-detail.html", SR_URL), SR_URL);
  assert.equal(r.layout, "search-results");
  assert.equal(r.sources.title, "search-title-link");
  assert.equal(r.sources.location, "title-link-sibling");
  assert.equal(r.sources.workplaceType, "search-results-links");
  assert.equal(r.job.title, "Graphic Designer");
});

test("search-results: header-anchored fallback works when the title is not a link", () => {
  const doc = load("job-detail.html", SR_URL);
  const a = xp(doc, "//p/a[contains(@href,'/jobs/view/')]");
  a.replaceWith(doc.createTextNode(a.textContent)); // synthetic: unlink the title
  const r = detail(doc, SR_URL);
  assert.equal(r.job.title, "Graphic Designer");
  assert.equal(r.sources.title, "header-anchored");
  assert.equal(r.sources.location, "header-anchored");
});

test("missing metadata: fields stay empty, failed selectors are reported, nothing is borrowed", () => {
  const doc = load("job-standalone.html");
  const meta = xp(doc, selectors.headerMeta, xp(doc, selectors.detailRoot));
  meta.remove();
  const pills = xp(doc, "//a[contains(@href,'/jobs/view/')][not(@aria-label)]/ancestor::div[2]");
  pills.remove();
  const r = detail(doc);
  assert.equal(r.reason, "ok");
  assert.equal(r.job.title, "Junior Graphic Designer");
  assert.equal(r.job.location, "");
  assert.equal(r.job.postedText, "");
  // The pills are gone, but this job's own description states "Location: Remote" and "Employment Type: Full-time".
  // Those explicit lines are used and labelled as such; the DOM selectors are still reported as failed.
  assert.equal(r.job.workplaceType, "Remote");
  assert.equal(r.job.employmentType, "Full-time");
  assert.equal(r.sources.workplaceType, "description-key-line");
  assert.equal(r.sources.employmentType, "description-key-line");
  assert.deepEqual(r.failed.sort(), ["applicantsText", "employmentType", "location", "postedText", "workplaceType"]);
  assert.equal(r.sources.location, null);
  assert.equal(r.job.extractionStatus, "partial", "location and posted date are core fields");
  assert.ok(r.job.extractionWarnings.includes("missing:location") && r.job.extractionWarnings.includes("missing:postedText"));
});

test("description not loaded yet (standalone and search)", () => {
  const sa = load("job-standalone.html");
  sa.querySelector("[data-testid='expandable-text-box']").remove();
  const r = detail(sa);
  assert.equal(r.job, null);
  assert.equal(r.reason, "description-not-loaded");
  assert.equal(r.checks.descriptionContainerFound, false);
  const sr = load("job-detail.html", SR_URL);
  sr.querySelector("[data-testid='expandable-text-box']").remove();
  assert.equal(detail(sr, SR_URL).reason, "description-not-loaded");
});

test("navigation without reload: stale DOM is refused until the panel catches up", () => {
  const doc = load("job-standalone.html");
  const NEXT = "https://www.linkedin.com/jobs/view/4490000001/";
  // URL already points at job B, DOM still shows job A.
  const stale = detail(doc, NEXT);
  assert.equal(stale.job, null);
  assert.equal(stale.reason, "page-id-mismatch");
  assert.equal(stale.checks.idMatchesPageUrl, false);
  // React re-renders the same container for job B.
  doc.getElementById("JobDetails_AboutTheJob_4480218579").id = "JobDetails_AboutTheJob_4490000001";
  doc.querySelector("p.kfek0j").textContent = "Brand Designer";
  const fresh = detail(doc, NEXT);
  assert.equal(fresh.reason, "ok");
  assert.equal(fresh.job.jobId, "4490000001");
  assert.equal(fresh.job.title, "Brand Designer");
  assert.equal(fresh.job.url, NEXT);
});

test("search-results: currentJobId in the URL must match the panel", () => {
  const r = detail(load("job-detail.html", SR_URL), "https://www.linkedin.com/jobs/search-results/?currentJobId=1234567890");
  assert.equal(r.reason, "page-id-mismatch");
});

test("changed DOM: no 'More options' button -> header selectors fail loudly, company link still works", () => {
  const doc = load("job-standalone.html");
  doc.querySelector("button[aria-label='More options']").remove();
  const r = detail(doc);
  assert.equal(r.reason, "ok");
  assert.equal(r.job.title, "");
  assert.equal(r.job.company, "YourfriendlyHR");
  assert.ok(r.failed.includes("title") && r.failed.includes("workplaceType"));
  assert.ok(r.job.description.length > 100);
});

test("changed DOM: lazy-column renamed -> the About section's header ancestor is used instead (same job id checks)", () => {
  const doc = load("job-standalone.html");
  doc.querySelector("[data-testid='lazy-column']").setAttribute("data-testid", "renamed");
  const r = detail(doc);
  assert.equal(r.reason, "ok");
  assert.equal(r.checks.rootSource, "about-ancestor-fallback");
  assert.equal(r.job.jobId, "4480218579");
  assert.equal(r.job.title, "Junior Graphic Designer");
  // And with neither a lazy-column nor a header there is still no panel, and no throw.
  doc.querySelector("button[aria-label='More options']").remove();
  const none = detail(doc);
  assert.deepEqual([none.job, none.reason], [null, "no-detail-panel"]);
});

test("unsupported layout: no detail extraction, diagnostics still work", () => {
  const url = "https://www.linkedin.com/company/capgemini/";
  const doc = load("job-standalone.html", url);
  const r = extractor.extractDetail(doc, NOW, url);
  assert.equal(r.reason, "unsupported-layout");
  assert.equal(extractor.diagnose(doc, url).layout, "unsupported");
});

test("diagnostics (standalone): layout, match counts, sources, id check; no page text", () => {
  const rep = extractor.diagnose(load("job-standalone.html"), SA_URL);
  assert.equal(rep.layout, "standalone-job");
  assert.equal(rep.detail.rootMatches, 1);
  assert.equal(rep.detail.reason, "ok");
  assert.equal(rep.detail.checks.idMatchesPageUrl, true);
  assert.equal(rep.detail.checks.descriptionContainerFound, true);
  assert.equal(rep.detail.selectorMatchCounts.pills["header-anchored"], 2);
  assert.equal(rep.detail.fieldSources.title, "header-anchored");
  assert.deepEqual(rep.detail.failedSelectors, []);
  assert.ok(rep.detail.missing.includes("skills") === false);
  assert.doesNotMatch(JSON.stringify(rep), /YourfriendlyHR|Junior Graphic|India|Adobe|₹/);
});

test("content script: SPA navigation is tracked (URL change seen after a DOM mutation)", async () => {
  const root = path.join(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const dom = new JSDOM(html("job-standalone.html"), { url: SA_URL, runScripts: "outside-only" });
  let listener;
  dom.window.chrome = { runtime: { onMessage: { addListener: (f) => (listener = f) } } };
  for (const f of manifest.content_scripts[0].js) dom.window.eval(fs.readFileSync(path.join(root, f), "utf8"));
  const call = (type) => new Promise((resolve) => listener({ type }, {}, resolve));

  const before = await call("DIAGNOSE");
  assert.equal(before.report.layout, "standalone-job");
  assert.equal(before.report.tracking.urlChanges, 0);

  dom.window.history.pushState({}, "", "/jobs/view/4490000001/");
  dom.window.document.body.appendChild(dom.window.document.createElement("div")); // React-style DOM update
  await new Promise((r) => setTimeout(r, 700)); // observer debounce is 500 ms
  const after = await call("DIAGNOSE");
  assert.equal(after.report.tracking.urlChanges, 1);
  assert.equal(after.report.detail.reason, "page-id-mismatch"); // DOM still shows the old job
  dom.window.close();
});

// ---------------------------------------------------------------- application status (open / closed / unknown)
// Closed markup below is the structure pasted from a live closed job (hashed classes dropped).
const CLOSED_NOTICE_HTML =
  '<div aria-atomic="true" aria-live="assertive"><svg id="signal-error-small" aria-hidden="false" role="img" aria-label="Error"><path d="M10.8 1H5.2z"></path></svg><p>No longer accepting applications</p></div>';

function standalone({ notice, keepApply = true, noticeOutsideRoot = false } = {}) {
  const doc = load("job-standalone.html");
  if (!keepApply) for (const b of doc.querySelectorAll("button[aria-label*='Apply']")) b.remove();
  if (notice) {
    const holder = doc.createElement("div");
    holder.innerHTML = notice;
    const target = noticeOutsideRoot ? doc.body : doc.querySelector("a[href*='/jobs/view/']").closest("div.kfeax9");
    target.appendChild(holder.firstElementChild);
  }
  return doc;
}

test("status: Apply button present and no closed notice -> open", () => {
  const r = detail(load("job-standalone.html"));
  assert.equal(r.job.applicationStatus, "open");
  assert.equal(r.job.applicationStatusText, "");
  assert.equal(r.sources.applicationStatus, "apply-button");
  assert.equal(r.checks.applicationStatusBasis, "apply-button");
  assert.ok(!r.failed.includes("applicationStatus"), "unknown status is not a selector failure");
});

test("status: 'Apply on company website' button (search-results panel) -> open", () => {
  const r = detail(load("job-detail.html", SR_URL), SR_URL);
  assert.equal(r.job.applicationStatus, "open");
});

test("status: the live closed notice -> closed, with its text", () => {
  const r = detail(standalone({ notice: CLOSED_NOTICE_HTML, keepApply: false }));
  assert.equal(r.reason, "ok");
  assert.equal(r.job.applicationStatus, "closed");
  assert.equal(r.job.applicationStatusText, "No longer accepting applications");
  assert.equal(r.sources.applicationStatus, "closed-notice");
  assert.equal(r.counts.applicationClosedNotice, 1);
});

test("status: a closed notice beats a leftover Apply button", () => {
  const r = detail(standalone({ notice: CLOSED_NOTICE_HTML, keepApply: true }));
  assert.equal(r.job.applicationStatus, "closed");
});

test("status: no notice and no Apply button -> unknown (empty), never guessed as open", () => {
  const r = detail(standalone({ keepApply: false }));
  assert.equal(r.reason, "ok");
  assert.equal(r.job.applicationStatus, "");
  assert.equal(r.job.applicationStatusText, "");
  assert.equal(r.checks.applicationStatusBasis, "no-evidence");
  assert.equal(r.sources.applicationStatus, null);
});

test("status: an error notice that does not say 'closed' is not treated as closed", () => {
  const other = CLOSED_NOTICE_HTML.replace("No longer accepting applications", "Something went wrong. Try again.");
  const r = detail(standalone({ notice: other, keepApply: false }));
  assert.equal(r.job.applicationStatus, "");
  assert.equal(r.checks.applicationStatusBasis, "notice-text-unrecognized");
});

test("status: a closed notice outside the job panel is ignored", () => {
  const r = detail(standalone({ notice: CLOSED_NOTICE_HTML, keepApply: false, noticeOutsideRoot: true }));
  assert.equal(r.job.applicationStatus, "");
});

test("status: other wordings of 'closed' are recognised, unrelated text is not", () => {
  const { classifyApplicationNotice: c } = globalThis.LJS.normalize;
  for (const t of ["No longer accepting applications", "Not accepting applications", "Applications are closed", "This position has been filled", "Job expired"]) {
    assert.equal(c(t), "closed", t);
  }
  for (const t of ["Be an early applicant", "Actively reviewing applicants", "Over 100 applicants", ""]) assert.equal(c(t), null, t);
});

test("status: diagnostics report evidence counts and the basis, not page text", () => {
  const rep = extractor.diagnose(standalone({ notice: CLOSED_NOTICE_HTML, keepApply: false }), SA_URL);
  assert.equal(rep.detail.selectorMatchCounts.applicationClosedNotice, 1);
  assert.equal(rep.detail.selectorMatchCounts.applyButton, 0);
  assert.equal(rep.detail.checks.applicationStatusBasis, "closed-notice");
  assert.equal(rep.detail.fieldSources.applicationStatus, "closed-notice");
  assert.doesNotMatch(JSON.stringify(rep), /No longer accepting/);
  const unknown = extractor.diagnose(standalone({ keepApply: false }), SA_URL);
  assert.ok(unknown.detail.missing.includes("applicationStatus"));
});
