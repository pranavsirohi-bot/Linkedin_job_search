// Full-field extraction: every field the two pasted layouts expose, the evidence-only parsers, extraction status and
// warnings, and the completeness report used by Preview extraction. Fixtures are trimmed copies of live markup;
// modified variants are SYNTHETIC. Passing here does not prove live compatibility.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

require("../src/extract/xpath-selectors.js");
require("../src/extract/normalize.js");
require("../src/extract/extractor.js");
const { extractor, normalize: N } = globalThis.LJS;

const SA_URL = "https://www.linkedin.com/jobs/view/4480218579/";
const SR_URL = "https://www.linkedin.com/jobs/search-results/?currentJobId=4480307941";
const NOW = new Date("2026-10-21T12:00:00Z");
const load = (name, url = SA_URL) => new JSDOM(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"), { url }).window.document;
const detail = (doc, url = SA_URL) => extractor.extractDetail(doc, NOW, url);

// ------------------------------------------------------------------ the open job: all fields from real markup
test("standalone job: basic, employment, application and description-derived fields", () => {
  const r = detail(load("job-standalone.html"));
  const j = r.job;
  assert.equal(r.reason, "ok");
  assert.deepEqual(
    [j.jobId, j.url, j.title, j.company, j.companyUrl, j.location, j.country, j.postedText, j.postedDateApprox, j.applicantsText],
    ["4480218579", SA_URL, "Junior Graphic Designer", "YourfriendlyHR", "https://www.linkedin.com/company/yourfriendlyhr/", "India", "India", "1 day ago", "2026-10-20", "Over 100 applicants"],
  );
  assert.deepEqual([j.workplaceType, j.employmentType, j.seniorityLevel], ["Remote", "Full-time", ""], "no seniority pill on this page -> empty, not guessed");
  assert.deepEqual([j.salary, j.salaryCurrency, j.salaryPeriod], ["Up to ₹35,000/month", "INR", "month"]);
  assert.deepEqual([j.applicationStatus, j.applicationMethod, j.hiringInsight], ["open", "easy_apply", "No response insights available yet"]);
  assert.equal(j.experience, "Fresher to Junior Level");
  assert.deepEqual(j.skills, ["graphic design", "design", "adobe", "aesthetics", "adobe creative suite"]);
  assert.equal(j.responsibilities.length, 4);
  assert.match(j.qualifications[0], /^Strong proficiency in Adobe Creative Suite/);
  assert.deepEqual([j.preferredQualifications, j.education, j.certifications], [[], [], []], "not stated in this description -> empty");
  assert.deepEqual([j.extractionStatus, j.extractionWarnings], ["complete", []]);
  assert.deepEqual([r.sources.applicationMethod, r.sources.hiringInsight, r.sources.country, r.sources.salary], ["apply-button-label", "header-anchored", "location-text", "description-text"]);
});

test("full description is complete readable text: line structure kept, the '… more' button and unrelated sections excluded", () => {
  const j = detail(load("job-standalone.html")).job;
  assert.ok(j.description.startsWith("One of our client is looking for a creative"));
  assert.ok(j.description.endsWith("Skills: graphic design,design,adobe,aesthetics,adobe creative suite"), "nothing truncated at the end");
  assert.match(j.description, /\n- Location: Remote\n/);
  assert.doesNotMatch(j.description, /… more|Show match details|missing some required qualifications|About the job/);
  assert.doesNotMatch(j.description, /<[a-z]/i, "no markup");
  assert.doesNotMatch(j.description, /\n{3,}/, "no runs of blank lines");
});

test("search-results panel: external application, hiring insight, no country when the location names none", () => {
  const r = detail(load("job-detail.html", SR_URL), SR_URL);
  const j = r.job;
  assert.deepEqual([j.jobId, j.title, j.company, j.location, j.country], ["4480307941", "Graphic Designer", "Capgemini", "Mumbai Metropolitan Region", ""]);
  assert.deepEqual([j.applicationMethod, j.hiringInsight, j.applicantsText], ["external", "Responses managed off LinkedIn", "Over 100 people clicked apply"]);
  assert.deepEqual([j.salary, j.salaryCurrency, j.salaryPeriod], ["", "", ""], "no pay stated -> nothing invented");
  assert.doesNotMatch(JSON.stringify(j), /Example Person|example-person/, "the 'People you can reach out to' section is never read");
  assert.equal(j.extractionStatus, "complete");
});

test("the description belongs to the job in the About section id; a panel showing another job is refused", () => {
  const doc = load("job-detail.html", SR_URL);
  const other = "https://www.linkedin.com/jobs/search-results/?currentJobId=4499999999";
  const r = detail(doc, other);
  assert.equal(r.job, null, "URL says job B, panel still shows job A: nothing is extracted");
  assert.equal(r.reason, "page-id-mismatch");
  const ok = detail(doc, SR_URL);
  assert.equal(ok.job.jobId, "4480307941");
  assert.equal(ok.job.url, "https://www.linkedin.com/jobs/view/4480307941/");
});

// ------------------------------------------------------------------ partial / failed
test("missing core fields make the record partial with specific warnings; a missing description means no record", () => {
  const doc = load("job-standalone.html");
  doc.querySelector("p.kfekz3").remove(); // the location / posted / applicants line
  const j = detail(doc).job;
  assert.equal(j.extractionStatus, "partial");
  for (const w of ["missing:location", "missing:postedText", "missing:applicantsText"]) assert.ok(j.extractionWarnings.includes(w), w);
  const noDesc = load("job-standalone.html");
  noDesc.querySelector("[data-testid='expandable-text-box']").remove();
  const r = detail(noDesc);
  assert.deepEqual([r.job, r.reason], [null, "description-not-loaded"]);
  assert.equal(extractor.completeness(r, []).detail.status, "failed");
});

test("a selector that matches an element but reads nothing is reported (content present, selector needs attention)", () => {
  const doc = load("job-standalone.html");
  doc.querySelector("button[aria-label='Easy Apply to this job']").setAttribute("aria-label", "Apply"); // still an Apply button
  doc.querySelector("div.kfekzn p").textContent = " "; // insight container present, no text
  const r = detail(doc);
  assert.equal(r.job.applicationMethod, "external");
  assert.ok(r.selectorIssues.includes("hiringInsight"));
  assert.ok(r.job.extractionWarnings.includes("selector-empty:hiringInsight"));
});

test("job cards are always partial ('card-only') and carry only list fields", () => {
  const doc = load("job-cards.html", "https://www.linkedin.com/jobs/search-results/");
  const cards = extractor.extractCards(doc, NOW);
  assert.ok(cards.length > 0);
  for (const c of cards) {
    assert.equal(c.source, "card");
    assert.deepEqual([c.extractionStatus, c.extractionWarnings], ["partial", ["card-only"]]);
    assert.equal(c.description, undefined, "a card never claims a description");
    assert.match(c.url, /^https:\/\/www\.linkedin\.com\/jobs\/view\/\d+\/$/);
  }
  const rep = extractor.completeness({ job: null, reason: "no-detail-panel" }, cards);
  assert.equal(rep.cards.status, "partial (card-only)");
  assert.ok(rep.cards.detailOnlyFields.includes("description"));
});

test("completeness report lists found, missing and not-stated fields by name only", () => {
  const r = detail(load("job-detail.html", SR_URL), SR_URL);
  const c = extractor.completeness(r, []);
  assert.equal(c.detail.status, "complete");
  assert.ok(c.detail.found.includes("applicationMethod") && c.detail.found.includes("hiringInsight"));
  assert.deepEqual(c.detail.missingCore, []);
  assert.ok(c.detail.notStatedOnPage.includes("salary") && c.detail.notStatedOnPage.includes("country"));
  assert.doesNotMatch(JSON.stringify(c), /Capgemini|frog|Graphic Designer/, "no page text in the report");
  const d = extractor.diagnose(load("job-detail.html", SR_URL), SR_URL);
  assert.equal(d.detail.extractionStatus, "complete");
  assert.ok(d.detail.missing.includes("salary"));
});

// ------------------------------------------------------------------ parsers: only what the text states
test("employment / workplace / seniority / salary pills are classified by exact wording", () => {
  const p = N.classifyPills(["Hybrid", "Contract", "Mid-Senior level", "₹6L/yr - ₹9L/yr", "Remote", "Benefits"]);
  assert.deepEqual(p, { workplaceType: "Hybrid", employmentType: "Contract", seniorityLevel: "Mid-Senior level", salary: "₹6L/yr - ₹9L/yr", otherPills: ["Benefits"] });
  assert.equal(N.classifyPills(["Senior"]).seniorityLevel, "", "not LinkedIn's wording -> not a seniority level");
  assert.equal(N.classifyPills(["Internship"]).employmentType, "Internship");
  assert.equal(N.classifyPills(["10 benefits"]).salary, "");
});

test("salary currency and period only when unambiguous", () => {
  const cases = [
    ["Up to ₹35,000/month", "INR", "month"], ["₹6L/yr - ₹9L/yr", "INR", "year"], ["8-12 LPA", "INR", "year"],
    ["USD 120,000 - 150,000 per year", "USD", "year"], ["$45/hr", "", "hour"], ["$120K/yr", "", "year"],
    ["€50,000 a year", "EUR", "year"], ["£30 per hour", "GBP", "hour"], ["Competitive", "", ""], ["", "", ""],
  ];
  for (const [t, cur, per] of cases) assert.deepEqual(N.parseSalaryDetails(t), { currency: cur, period: per }, t);
});

test("country only when the location text ends with a country name", () => {
  assert.equal(N.countryFromLocation("Pune, Maharashtra, India"), "India");
  assert.equal(N.countryFromLocation("India (Remote)"), "India");
  assert.equal(N.countryFromLocation("London, England, United Kingdom"), "United Kingdom");
  assert.equal(N.countryFromLocation("Mumbai Metropolitan Region"), "");
  assert.equal(N.countryFromLocation("Bengaluru"), "", "never inferred from a city");
  assert.equal(N.countryFromLocation(""), "");
});

test("explicit key lines supply employment/workplace only with a known value; apply labels map to a method", () => {
  assert.deepEqual(N.parseKeyValueFields("- Employment Type: Full-time\n- Location: Remote"), { workplaceType: "Remote", employmentType: "Full-time" });
  assert.deepEqual(N.parseKeyValueFields("Location: Pune, India\nJob type: Permanent role"), { workplaceType: "", employmentType: "" });
  assert.deepEqual(N.parseKeyValueFields("Work mode: Hybrid"), { workplaceType: "Hybrid", employmentType: "" });
  assert.deepEqual(["Easy Apply to this job", "Apply on company website", "Save the job", ""].map(N.classifyApplyLabel), ["easy_apply", "external", "", ""]);
});

test("sections: preferred qualifications, education and certifications are copied from the text, never generated", () => {
  const d = [
    "About us", "We build things.", "",
    "Responsibilities", "- Build features", "",
    "Requirements", "- 3+ years of JavaScript", "- Bachelor's degree in Computer Science or equivalent", "",
    "Preferred Qualifications", "- Experience with Chrome extensions", "",
    "Nice to have", "- AWS Certified Developer certification", "",
    "Education", "- B.Tech / B.E. in any discipline",
  ].join("\n");
  const s = N.parseSections(d);
  assert.deepEqual(s.responsibilities, ["Build features"]);
  assert.deepEqual(s.qualifications, ["3+ years of JavaScript", "Bachelor's degree in Computer Science or equivalent"]);
  assert.deepEqual(s.preferredQualifications, ["Experience with Chrome extensions", "AWS Certified Developer certification"]);
  assert.deepEqual(s.education, ["B.Tech / B.E. in any discipline"]);
  assert.deepEqual(N.parseEducation(d, s.education), ["B.Tech / B.E. in any discipline", "Bachelor's degree in Computer Science or equivalent"]);
  assert.deepEqual(N.parseCertifications(d, s.certifications), ["AWS Certified Developer certification"]);
  const plain = "We are a small team. You will design posters and social media posts.";
  assert.deepEqual([N.parseEducation(plain), N.parseCertifications(plain), N.parseSections(plain).preferredQualifications], [[], [], []]);
});

test("experience and skills: explicit lines only", () => {
  assert.equal(N.parseExperience("Experience: 2-4 years in UI design"), "2-4 years in UI design");
  assert.match(N.parseExperience("You have 5+ years of experience with React."), /^5\+? ?years/);
  assert.equal(N.parseExperience("Fresh ideas welcome."), "");
  assert.deepEqual(N.parseSkills("Skills: Figma, Photoshop; Illustrator"), ["Figma", "Photoshop", "Illustrator"]);
  assert.deepEqual(N.parseSkills("We use Figma and Photoshop daily."), [], "no vocabulary guessing");
});

// ------------------------------------------------------------------ audit regressions (0.8.1): no fabricated values
test("common company/boilerplate phrases are never taken as education, certification, salary or experience", () => {
  const none = {
    education: ["- Certified Scrum Master preferred", "We offer a 360-degree view of your growth.", "Work with our master data team", "You will master new tools quickly"],
    certifications: ["We are a certified B Corp and Great Place to Work Certified.", "All software is licensed under MIT.", "ISO 9001 certified company"],
    salary: ["We raised $20M in Series B funding.", "Our clients include a $5B retailer.", "We are a ₹500 crore company."],
    experience: ["We have over 20 years of history in the industry.", "Founded 15 years ago, we serve 40 countries."],
  };
  for (const l of none.education) assert.deepEqual(N.parseEducation(l), [], l);
  for (const l of none.certifications) assert.deepEqual(N.parseCertifications(l), [], l);
  for (const l of none.salary) assert.equal(N.parseSalary(l), "", l);
  for (const l of none.experience) assert.equal(N.parseExperience(l), "", l);
});

test("real requirements are still recognised", () => {
  for (const l of ["- Bachelor's degree in Computer Science", "B.Tech in IT or equivalent", "Master’s in Design preferred", "MBA from a reputed institute"]) assert.equal(N.parseEducation(l).length, 1, l);
  for (const l of ["- AWS Certified Solutions Architect", "PMP certification is a plus", "Google UX Design Certificate preferred"]) assert.equal(N.parseCertifications(l).length, 1, l);
  assert.equal(N.parseSalary("Salary: ₹4,00,000 - ₹6,00,000 per annum"), "₹4,00,000 - ₹6,00,000 per annum");
  assert.equal(N.parseSalary("Compensation: $120,000 - $150,000/year"), "$120,000 - $150,000/year");
  assert.equal(N.parseSalary("Stipend: ₹15,000/month"), "₹15,000/month");
  assert.equal(N.parseSalary("CTC: 6-8 LPA"), "6-8 LPA");
  assert.equal(N.parseSalary("Up to ₹35,000/month"), "Up to ₹35,000/month", "a figure followed by a pay period needs no pay word");
  assert.equal(N.parseExperience("Minimum 5 years of relevant experience"), "5 years of relevant experience");
  assert.equal(N.parseExperience("- 1 to 3 years of experience in design"), "1 to 3 years of experience in design");
});

test("blank detail fields are filled only from the SAME job's card, then the record is graded again", () => {
  const doc = load("job-standalone.html");
  doc.querySelector("p.kfekz3 span").textContent = ""; // location span empty; posted / applicants remain
  const r = detail(doc);
  assert.deepEqual([r.job.location, r.job.extractionStatus], ["", "partial"]);
  const other = { source: "card", jobId: "4499999999", location: "Elsewhere", title: "Other job" };
  extractor.withCardFallback(r, [other]);
  assert.equal(r.job.location, "", "another job's card is never used");
  const own = { source: "card", jobId: "4480218579", location: "Pune, Maharashtra, India", country: "India", title: "x" };
  extractor.withCardFallback(r, [other, own]);
  assert.deepEqual([r.job.location, r.sources.location, r.job.title], ["Pune, Maharashtra, India", "job-card", "Junior Graphic Designer"], "only blanks are filled");
  assert.deepEqual([r.job.extractionStatus, r.job.extractionWarnings.includes("missing:location")], ["complete", false]);
  assert.equal(extractor.withCardFallback({ job: null, reason: "no-detail-panel" }, [own]).job, null);
});

// ------------------------------------------------------------------ live markup pasted 2026-10-22 (job 4303643872)
const LIVE_URL = "https://www.linkedin.com/jobs/search-results/?currentJobId=4303643872&eBP=NOT_ELIGIBLE_FOR_CHARGING";
test("2026-10-22 panel: every header field, and the external Apply LINK gives status, method and the employer URL", () => {
  const r = detail(load("job-search-2026-10-22.html", LIVE_URL), LIVE_URL);
  const j = r.job;
  assert.equal(r.reason, "ok");
  assert.deepEqual(
    [j.jobId, j.url, j.title, j.company, j.location, j.country, j.postedText, j.applicantsText, j.workplaceType, j.employmentType, j.hiringInsight],
    ["4303643872", "https://www.linkedin.com/jobs/view/4303643872/", "Wordpress Developer", "OptiPhoenix", "Delhi, Delhi, India", "India", "1 year ago", "Over 100 people clicked apply", "On-site", "Full-time", "Responses managed off LinkedIn"],
  );
  assert.deepEqual([j.applicationStatus, j.applicationMethod], ["open", "external"], "the Apply control is an <a>, not a <button>");
  assert.equal(j.applicationUrl, "https://optiphoenix.keka.com/careers/jobdetails/107156?source=linkedin", "decoded from LinkedIn's safety redirect");
  assert.deepEqual(j.benefits, ["Medical insurance"]);
  assert.deepEqual([j.extractionStatus, j.extractionWarnings], ["complete", []]);
});

test("2026-10-22 panel: full description and correctly separated sections", () => {
  const j = detail(load("job-search-2026-10-22.html", LIVE_URL), LIVE_URL).job;
  assert.ok(j.description.startsWith("About The Company\n"));
  assert.ok(j.description.endsWith("committed to building a versatile environment for all our employees."), "not cut at the '… more' point");
  assert.doesNotMatch(j.description, /… more|Medical insurance|People you can reach out to|Example Person|16,952 followers|Show match details/);
  assert.equal(j.responsibilities.length, 9, "'What You Do' is a responsibilities heading");
  assert.equal(j.responsibilities[0], "Develop and enhance WordPress websites with a strong focus on improving user interface and user experience.");
  assert.equal(j.qualifications.length, 8);
  assert.ok(!j.qualifications.some((q) => /Health Insurance|equal opportunity|Benefits of working/.test(q)), "benefits / EEO lines are not requirements");
  assert.equal(j.experience, "3+ years of experience in WordPress development with a strong portfolio demonstrating your capabilities");
  assert.deepEqual([j.salary, j.skills, j.education, j.certifications], ["", [], [], []], "not stated -> empty");
});

test("employer application URL: only a real https employer page, never LinkedIn or a script URL", () => {
  const go = (u) => `https://www.linkedin.com/safety/go/?url=${encodeURIComponent(u)}&urlhash=x`;
  assert.equal(N.externalApplyUrl(go("https://jobs.example.com/apply/1?src=li")), "https://jobs.example.com/apply/1?src=li");
  assert.equal(N.externalApplyUrl("https://careers.example.org/job/7"), "https://careers.example.org/job/7");
  for (const bad of [go("javascript:alert(1)"), go("http://jobs.example.com/"), go("https://www.linkedin.com/jobs/view/1/"), "https://www.linkedin.com/jobs/view/1/", go("https://user:pw@example.com/"), "", "not a url"]) {
    assert.equal(N.externalApplyUrl(bad), "", bad);
  }
  const doc = load("job-standalone.html");
  assert.equal(detail(doc).job.applicationUrl, "", "Easy Apply has no external URL");
});

// ------------------------------------------------------------------ live markup pasted 2026-10-22 (job 4454777534)
const LIVE_B = "https://www.linkedin.com/jobs/search-results/?currentJobId=4454777534";
test("2026-10-22 rich-text job: responsibilities under sub-headings, qualifications, preferred, education", () => {
  const j = detail(load("job-search-2026-10-22b.html", LIVE_B), LIVE_B).job;
  assert.equal(j.description.length > 8000, true, "full description");
  assert.ok(j.description.endsWith("We do not and will not ask you to send or share with us any sensitive personal data."));
  assert.equal(j.responsibilities.length, 70, "all bullets under Responsibilities' sub-headings + Role Expectations");
  assert.equal(j.responsibilities[0], "Take technical ownership of multiple WordPress websites.");
  assert.ok(j.responsibilities.includes("Monitor uptime and overall website health."));
  assert.ok(!j.responsibilities.some((r) => /equal opportunity|Be Part of Something Big|Why You/.test(r)), "benefits and EEO text are not responsibilities");
  assert.equal(j.qualifications.length, 13);
  assert.equal(j.preferredQualifications.length, 11);
  assert.deepEqual(j.education, ["Bachelor's degree in Computer Science, Engineering, Information Technology, or equivalent practical experience."]);
  assert.deepEqual(j.certifications, [], "'Manage SSL/certificate requirements.' is a task, not a certification");
  assert.equal(j.experience, "8+ years of professional web development experience");
  assert.deepEqual([j.industry, j.companySize], ["Business Consulting and Services", "1001-5000 employees"]);
  assert.doesNotMatch(JSON.stringify(j), /Example Poster|example-poster|Talent Acquisition Partner/, "the hiring team is not read");
});

test("company facts: industry only when the facts block is recognised", () => {
  assert.deepEqual(N.parseCompanyFacts(["TeKnowledge", "167,795 followers", "Business Consulting and Services", " • ", "1001-5000 employees", " • ", "1,919 on LinkedIn"], "TeKnowledge"), { industry: "Business Consulting and Services", companySize: "1001-5000 employees" });
  assert.deepEqual(N.parseCompanyFacts(["Capgemini"], "Capgemini"), { industry: "", companySize: "" });
  assert.deepEqual(N.parseCompanyFacts(["Some text"], "Acme"), { industry: "", companySize: "" }, "no size/followers line -> nothing guessed");
  assert.equal(detail(load("job-search-2026-10-22.html", LIVE_URL), LIVE_URL).job.industry, "IT Services and IT Consulting");
  assert.equal(detail(load("job-detail.html", SR_URL), SR_URL).job.industry, "");
});

// ------------------------------------------------------------------ stored job 4476650532 (real description structure)
test("sections: 'Mandatory Skills:' and 'Who Can Apply?' are requirements; application-form lines are never saved", () => {
  const d = [
    "Greetings from Example Labs!!", "Job Role: Web Developer", "Work Mode: Onsite", "",
    "Mandatory Skills:", "- Strong fundamentals in HTML5, CSS3, and JavaScript.", "- Working knowledge of TypeScript.", "",
    "Good-to-Have Skills:", "- Headless CMS and decoupled frontend architecture.", "",
    "Key Responsibilities:", "- Build responsive, fast-loading web pages.", "- Develop lightweight backend services using Node.js.", "",
    "Who Can Apply?", "✔️ Developers with hands-on experience building websites end-to-end.", "✔️ Strong knowledge of HTML, CSS, JavaScript.", "",
    "Please share the following details along with your updated resume/portfolio:", "",
    "Candidate Details:", "Email: recruiter@example.com", "Full Name:", "Total Experience:", "CMS Experience (WordPress / Drupal):",
    "Thanks and Regards,", "TAG Team",
  ].join("\n");
  const s = N.parseSections(d);
  assert.deepEqual(s.qualifications, ["Strong fundamentals in HTML5, CSS3, and JavaScript.", "Working knowledge of TypeScript.", "Developers with hands-on experience building websites end-to-end.", "Strong knowledge of HTML, CSS, JavaScript."]);
  assert.deepEqual(s.preferredQualifications, ["Headless CMS and decoupled frontend architecture."]);
  assert.deepEqual(s.responsibilities, ["Build responsive, fast-loading web pages.", "Develop lightweight backend services using Node.js."]);
  assert.doesNotMatch(JSON.stringify(s), /recruiter@|Full Name|Please share|Total Experience|Regards|CMS Experience \(/);
});

test("several candidate panels: the one whose About id matches the selected job is used; otherwise nothing", () => {
  const doc = load("job-search-2026-10-22.html", LIVE_URL);
  const panel = doc.querySelector("[data-testid='lazy-column']");
  const copy = panel.cloneNode(true); // e.g. the previous job's panel still in the DOM
  copy.querySelector("[id^='JobDetails_AboutTheJob_']").id = "JobDetails_AboutTheJob_4499999999";
  copy.querySelector("[data-testid='expandable-text-box']").textContent = "Another job's description";
  panel.parentNode.insertBefore(copy, panel);
  const r = detail(doc, LIVE_URL);
  assert.equal(r.reason, "ok");
  assert.equal(r.job.jobId, "4303643872");
  assert.doesNotMatch(r.job.description, /Another job's description/);
  assert.equal(r.checks.candidatePanels, 2);
  const other = "https://www.linkedin.com/jobs/search-results/?currentJobId=4411111111";
  const none = detail(doc, other);
  assert.deepEqual([none.job, none.reason, none.checks.pageUrlId], [null, "ambiguous-detail-root", "4411111111"], "no confident match -> nothing extracted");
});

test("identity checks report the selected job, the panel's job and the description length", () => {
  const r = detail(load("job-search-2026-10-22.html", LIVE_URL), LIVE_URL);
  assert.deepEqual([r.checks.pageUrlId, r.checks.aboutId, r.checks.titleLinkId, r.checks.idMatchesPageUrl], ["4303643872", "4303643872", "4303643872", true]);
  assert.ok(r.checks.descriptionChars > 3000);
});
