// Runs the extraction modules against fixtures of the pasted LinkedIn markup using jsdom.
// These tests prove the selectors match the SUPPLIED markup. They do not prove anything about the live site.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

require("../src/extract/xpath-selectors.js");
require("../src/extract/normalize.js");
require("../src/extract/extractor.js");
const { extractor, normalize: N } = globalThis.LJS;

const load = (name) =>
  new JSDOM(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"), {
    url: "https://www.linkedin.com/jobs/search-results/?currentJobId=4480307941",
  }).window.document;

const NOW = new Date("2026-10-21T12:00:00Z");

test("cards: matches only role=button cards and dedupes by job ID", () => {
  const doc = load("job-cards.html");
  const cards = extractor.extractCards(doc, NOW);
  assert.deepEqual(cards.map((c) => c.jobId), ["4480307941", "4450363857", "4400000001"]);
});

test("cards: real card fields", () => {
  const c = extractor.extractCards(load("job-cards.html"), NOW)[0];
  assert.equal(c.title, "Graphic Designer");
  assert.equal(c.company, "Capgemini");
  assert.equal(c.location, "Mumbai Metropolitan Region");
  assert.equal(c.url, "https://www.linkedin.com/jobs/view/4480307941/");
});

test("cards: '(Remote)' in location becomes workplaceType", () => {
  const c = extractor.extractCards(load("job-cards.html"), NOW)[1];
  assert.equal(c.location, "India");
  assert.equal(c.workplaceType, "Remote");
});

test("cards: missing company/location do not throw", () => {
  const c = extractor.extractCards(load("job-cards.html"), NOW)[2];
  assert.equal(c.title, "Mystery Role");
  assert.equal(c.company, "");
  assert.equal(c.location, "");
});

test("detail: header fields", () => {
  const { job, reason } = extractor.extractDetail(load("job-detail.html"), NOW);
  assert.equal(reason, "ok");
  assert.equal(job.jobId, "4480307941");
  assert.equal(job.url, "https://www.linkedin.com/jobs/view/4480307941/"); // tracking params stripped
  assert.equal(job.title, "Graphic Designer");
  assert.equal(job.company, "Capgemini");
  assert.equal(job.companyUrl, "https://www.linkedin.com/company/capgemini/");
  assert.equal(job.location, "Mumbai Metropolitan Region");
  assert.equal(job.postedText, "5 days ago");
  assert.equal(job.postedDateApprox, "2026-10-16");
  assert.equal(job.applicantsText, "Over 100 people clicked apply");
});

test("detail: pills classified by text", () => {
  const { job } = extractor.extractDetail(load("job-detail.html"), NOW);
  assert.equal(job.workplaceType, "Remote");
  assert.equal(job.employmentType, "Full-time");
  assert.deepEqual(job.otherPills, []);
});

test("detail: description is full, structured, and excludes the '… more' button", () => {
  const { job } = extractor.extractDetail(load("job-detail.html"), NOW);
  assert.match(job.description, /frog is part of Capgemini Invent/);
  assert.match(job.description, /\n- Study design briefs and determine requirements/);
  assert.match(job.description, /Equal Opportunity Employers/);
  assert.doesNotMatch(job.description, /… more|… ?more/);
});

test("detail: does not read match-prompt or people-you-can-reach-out-to sections", () => {
  const { job } = extractor.extractDetail(load("job-detail.html"), NOW);
  const blob = JSON.stringify(job);
  assert.doesNotMatch(blob, /Example Person|Show match details|missing some required/);
});

test("detail: heuristic sections", () => {
  const { job } = extractor.extractDetail(load("job-detail.html"), NOW);
  assert.ok(job.responsibilities.includes("Study design briefs and determine requirements"));
  assert.ok(job.qualifications.includes("Experience in both print and digital media"));
  assert.ok(!job.qualifications.some((l) => /flexible work/.test(l)), "stops at unrelated heading");
  assert.equal(job.salary, ""); // none disclosed in this posting
});

test("detail: absent panel reports reason instead of throwing", () => {
  const r = extractor.extractDetail(load("job-cards.html"), NOW);
  assert.equal(r.job, null);
  assert.equal(r.reason, "no-detail-panel");
});

test("detail: description still loading -> not extracted", () => {
  const doc = load("job-detail.html");
  doc.querySelector("[data-testid='expandable-text-box']").remove();
  assert.equal(extractor.extractDetail(doc, NOW).reason, "description-not-loaded");
});

test("detail: header/section ID mismatch (panel mid-update) -> not extracted", () => {
  const doc = load("job-detail.html");
  doc.getElementById("JobDetails_AboutTheJob_4480307941").id = "JobDetails_AboutTheJob_1111111111";
  assert.equal(extractor.extractDetail(doc, NOW).reason, "panel-loading-id-mismatch");
});

test("diagnose: counts and missing fields, no text content", () => {
  const rep = extractor.diagnose(load("job-detail.html"));
  assert.equal(rep.layout, "search-results");
  assert.equal(rep.detail.rootMatches, 1);
  assert.equal(rep.detail.selectorMatchCounts.title["search-title-link"], 1);
  assert.equal(rep.detail.selectorMatchCounts.description, 1);
  assert.equal(rep.detail.fieldSources.title, "search-title-link");
  assert.equal(rep.detail.checks.descriptionContainerFound, true);
  assert.equal(rep.detail.checks.idMatchesPageUrl, true);
  assert.ok(rep.detail.missing.includes("salary") && rep.detail.missing.includes("skills"));
  assert.ok(!rep.detail.missing.includes("title") && !rep.detail.missing.includes("description"));
  assert.doesNotMatch(JSON.stringify(rep), /Capgemini|Graphic Designer/);
  const cardRep = extractor.diagnose(load("job-cards.html"));
  assert.equal(cardRep.cards.count, 4);
  assert.equal(cardRep.cards.missingCompany, 1);
  assert.equal(cardRep.detail.reason, "no-detail-panel");
});

test("normalize: URL validation rejects non-LinkedIn and non-job URLs", () => {
  assert.equal(N.canonicalJobUrl("https://evil.com/jobs/view/12345678/"), null);
  assert.equal(N.canonicalJobUrl("http://www.linkedin.com/jobs/view/12345678/"), null);
  assert.equal(N.canonicalJobUrl("https://www.linkedin.com/in/someone/"), null);
  assert.equal(N.canonicalJobUrl("javascript:alert(1)"), null);
  assert.equal(N.canonicalJobUrl("/jobs/view/12345678/?x=1", "https://www.linkedin.com/"), "https://www.linkedin.com/jobs/view/12345678/");
  assert.equal(N.canonicalJobUrl("https://www.linkedin.com/jobs/view/graphic-designer-at-x-4480307941"), "https://www.linkedin.com/jobs/view/4480307941/");
});

test("normalize: relative dates, salary, whitespace", () => {
  assert.equal(N.parseRelativeDate("2 weeks ago", NOW), "2026-10-07");
  assert.equal(N.parseRelativeDate("Reposted 1 day ago", NOW), "2026-10-20");
  assert.equal(N.parseRelativeDate("Just now", NOW), null);
  assert.equal(N.parseSalary("Pay: $90,000 - $110,000 per year"), "$90,000 - $110,000 per year");
  assert.equal(N.cleanText("  a  b \n c "), "a b c");
});

test("selectors: company link found when anchors are nested (script-built DOM, as on the live page)", () => {
  const doc = load("job-detail.html");
  const outer = doc.createElement("a");
  outer.setAttribute("href", "https://www.linkedin.com/company/acme/life/");
  const inner = doc.createElement("a");
  inner.setAttribute("href", "https://www.linkedin.com/company/acme/life/");
  inner.textContent = "Acme";
  const p = doc.createElement("p");
  p.appendChild(inner);
  outer.appendChild(p); // <a><p><a>Acme</a></p></a> : impossible via the HTML parser
  const holder = doc.createElement("div");
  holder.appendChild(outer);
  const r = doc.evaluate(globalThis.LJS.selectors.company, holder, null, 2, null).stringValue;
  assert.equal(r, "Acme");
});
