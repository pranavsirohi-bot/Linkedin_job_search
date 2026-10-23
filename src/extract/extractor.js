// DOM -> job record extraction using XPath selectors. Read-only; never clicks or navigates.
// Depends on LJS.selectors, LJS.layouts and LJS.normalize (loaded before this file).
(function (root) {
  const LJS = (root.LJS = root.LJS || {});
  const S = () => LJS.selectors;
  const N = () => LJS.normalize;

  const SNAPSHOT = 7; // XPathResult.ORDERED_NODE_SNAPSHOT_TYPE
  const STRING = 2; // XPathResult.STRING_TYPE

  function nodes(doc, xpath, ctx) {
    const r = doc.evaluate(xpath, ctx || doc, null, SNAPSHOT, null);
    const out = [];
    for (let i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i));
    return out;
  }
  const first = (doc, xpath, ctx) => nodes(doc, xpath, ctx)[0] || null;
  const str = (doc, xpath, ctx) => N().cleanText(doc.evaluate(xpath, ctx || doc, null, STRING, null).stringValue);

  // Text of a node keeping <br>/<li>/<ul> line structure; skips the "… more" button and scripts.
  function readStructuredText(node, skip) {
    let out = "";
    const walk = (n) => {
      if (n.nodeType === 3) { out += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "svg" || (skip && skip.has(n))) return;
      if (tag === "br") { out += "\n"; return; }
      if (tag === "li") out += "\n- ";
      if (tag === "ul" || tag === "ol" || tag === "p" || tag === "div") out += "\n";
      for (const c of n.childNodes) walk(c);
      if (tag === "ul" || tag === "ol" || tag === "li" || tag === "p" || tag === "div") out += "\n";
    };
    walk(node);
    return N().cleanMultiline(out);
  }

  // ---- Cards ----
  function extractCard(doc, card, now) {
    const jobId = str(doc, S().cardId, card);
    if (!jobId) return null;
    const title = str(doc, S().cardTitle, card);
    const company = str(doc, S().cardCompany, card);
    const loc = N().splitLocation(str(doc, S().cardLocation, card));
    return {
      source: "card",
      jobId,
      url: N().canonicalJobUrl(`/jobs/view/${jobId}/`),
      title,
      company,
      location: loc.location,
      country: N().countryFromLocation(loc.location),
      workplaceType: loc.workplaceType,
      // A list card never carries the description or the detail fields: it is partial by definition.
      extractionStatus: "partial",
      extractionWarnings: ["card-only"],
      collectedAt: (now || new Date()).toISOString(),
    };
  }

  // All cards currently rendered, de-duplicated by job ID within this call.
  function extractCards(doc, now) {
    const seen = new Set();
    const out = [];
    for (const el of nodes(doc, S().card)) {
      const rec = extractCard(doc, el, now);
      if (!rec || seen.has(rec.jobId)) continue;
      seen.add(rec.jobId);
      out.push(rec);
    }
    return out;
  }

  // ---- Layout detection ----
  // URL is authoritative (LinkedIn is a SPA; the DOM may still hold the previous page for a moment).
  //   /jobs/view/<id>   -> standalone-job
  //   other /jobs/...   -> search-results (card list + selected-job panel)
  //   anything else     -> unsupported (cards may still be read; no detail extraction)
  function detectLayout(pageUrl) {
    let path = "";
    try { path = new URL(pageUrl).pathname; } catch { return "unsupported"; }
    if (/^\/jobs\/view\//.test(path)) return "standalone-job";
    if (path.startsWith("/jobs")) return "search-results";
    return "unsupported";
  }

  // The job ID the browser URL says we are on (null if the URL carries none).
  function pageJobId(layout, pageUrl) {
    try {
      if (layout === "standalone-job") return N().jobIdFromUrl(pageUrl);
      return new URL(pageUrl).searchParams.get("currentJobId");
    } catch { return null; }
  }

  // ---- Field-level candidate selection ----
  // Each picker tries the layout's candidates in order, returns the first non-empty result, and reports
  // every candidate's match count so diagnostics can show which selector supplied the field.
  function pickString(doc, ctx, candidates) {
    const counts = {};
    let value = "", source = null;
    for (const cand of candidates) {
      counts[cand.name] = (counts[cand.name] || 0) + nodes(doc, cand.xpath, ctx).length;
      if (!value) {
        const v = str(doc, cand.xpath, ctx);
        if (v) { value = v; source = cand.name; }
      }
    }
    return { value, source, counts };
  }

  // Meta line: first candidate <p> that yields at least one non-empty span.
  function pickMeta(doc, ctx, candidates) {
    const counts = {};
    let spans = [], source = null;
    for (const cand of candidates) {
      const found = nodes(doc, cand.xpath, ctx);
      counts[cand.name] = (counts[cand.name] || 0) + found.length;
      if (!spans.length && found[0]) {
        const t = nodes(doc, S().metaSpans, found[0]).map((n) => n.textContent);
        if (t.length) { spans = t; source = cand.name; }
      }
    }
    return { spans, source, counts };
  }

  function pickPills(doc, ctx, candidates) {
    const counts = {};
    let texts = [], source = null;
    for (const cand of candidates) {
      const found = nodes(doc, cand.xpath, ctx).map((n) => n.textContent);
      counts[cand.name] = (counts[cand.name] || 0) + found.length;
      if (!texts.length && found.length) { texts = found; source = cand.name; }
    }
    return { texts, source, counts };
  }

  // ---- Completeness ----
  // CORE fields must all be present for a "complete" record; EXPECTED fields are normally shown by LinkedIn and are
  // reported as warnings when missing; OPTIONAL fields appear only when the job states them (no warning).
  const CORE_FIELDS = ["jobId", "url", "title", "company", "location", "postedText", "description"];
  const EXPECTED_FIELDS = ["workplaceType", "employmentType", "applicantsText", "applicationStatus", "applicationMethod"];
  const OPTIONAL_FIELDS = [
    "country", "seniorityLevel", "salary", "salaryCurrency", "salaryPeriod", "experience", "skills", "responsibilities",
    "qualifications", "preferredQualifications", "education", "certifications", "hiringInsight", "companyUrl",
    "applicationUrl", "benefits", "industry", "companySize",
  ];
  // Fields a search-results card cannot carry (they exist only in the open job's detail view).
  const DETAIL_ONLY_FIELDS = [
    "description", "postedText", "applicantsText", "employmentType", "applicationStatus", "applicationMethod",
    "seniorityLevel", "salary", "experience", "skills", "responsibilities", "qualifications", "preferredQualifications",
    "education", "certifications", "hiringInsight", "companyUrl", "applicationUrl", "benefits", "industry", "companySize",
  ];
  const isBlank = (v) => v == null || v === "" || (Array.isArray(v) && v.length === 0);

  function grade(job, selectorIssues) {
    const missingCore = CORE_FIELDS.filter((f) => isBlank(job[f]));
    const missingExpected = EXPECTED_FIELDS.filter((f) => isBlank(job[f]));
    const warnings = [
      ...missingCore.map((f) => `missing:${f}`),
      ...missingExpected.map((f) => `missing:${f}`),
      ...selectorIssues.map((f) => `selector-empty:${f}`),
    ];
    return { status: missingCore.length ? "partial" : "complete", warnings: [...new Set(warnings)].slice(0, 50) };
  }

  // ---- Detail ----
  // Returns { job, reason, layout, sources, checks, failed, counts }. job is null when the panel is absent,
  // still loading, or inconsistent with the page URL. Missing fields stay empty and are listed in `failed`;
  // nothing is ever filled in from unrelated page text.
  function extractDetail(doc, now, pageUrl) {
    const base = pageUrl || (doc.location && doc.location.href) || "https://www.linkedin.com/";
    const layout = detectLayout(base);
    const res = { job: null, reason: "", layout, sources: {}, checks: {}, failed: [], counts: {} };
    if (layout === "unsupported") return { ...res, reason: "unsupported-layout" };

    // Find the panel of the job the URL says is open. Several candidate panels (LinkedIn keeps a previous job's panel
    // while rendering the next one) are resolved by job ID; if none matches confidently, nothing is extracted.
    let rootEls = nodes(doc, S().detailRoot);
    res.counts.detailRoot = rootEls.length;
    if (!rootEls.length) {
      rootEls = nodes(doc, S().detailRootFallback);
      res.counts.detailRootFallback = rootEls.length;
      if (rootEls.length) res.checks.rootSource = "about-ancestor-fallback";
    }
    const wantedId = pageJobId(layout, base);
    if (rootEls.length > 1) {
      const matching = wantedId ? rootEls.filter((el) => str(doc, S().aboutId, el) === wantedId) : [];
      if (matching.length !== 1) return { ...res, reason: "ambiguous-detail-root", checks: { ...res.checks, pageUrlId: wantedId || null, candidatePanels: rootEls.length } };
      rootEls = matching;
      res.checks.candidatePanels = res.counts.detailRoot || res.counts.detailRootFallback;
    }
    if (!rootEls.length) return { ...res, reason: "no-detail-panel", checks: { ...res.checks, pageUrlId: wantedId || null } };
    const r = rootEls[0];
    const L = LJS.layouts[layout];

    const aboutId = str(doc, S().aboutId, r);
    const titleHref = pickString(doc, r, L.titleHref);
    const hrefUrl = N().canonicalJobUrl(titleHref.value, base);
    const hrefId = hrefUrl ? N().jobIdFromUrl(hrefUrl) : null;
    const urlId = pageJobId(layout, base);
    const jobId = aboutId || hrefId || urlId || "";
    res.checks = {
      ...res.checks,
      aboutId: aboutId || null,
      titleLinkId: hrefId,
      pageUrlId: urlId,
      idMatchesPageUrl: urlId && aboutId ? urlId === aboutId : null,
      descriptionContainerFound: false,
    };
    if (!jobId) return { ...res, reason: "no-job-id" };
    // Panel mid-update: header link from one job, sections from another.
    if (aboutId && hrefId && hrefId !== aboutId) return { ...res, reason: "panel-loading-id-mismatch" };
    // Browser URL already moved to another job but the DOM still shows the previous one.
    if (res.checks.idMatchesPageUrl === false) return { ...res, reason: "page-id-mismatch" };

    const descEl = first(doc, S().description, r);
    res.checks.descriptionContainerFound = !!descEl;
    if (!descEl) return { ...res, reason: "description-not-loaded" };
    const skip = new Set(nodes(doc, S().descriptionButton, descEl));
    const description = readStructuredText(descEl, skip);
    res.checks.descriptionChars = description.length;
    if (!description) return { ...res, reason: "description-empty" };

    const title = pickString(doc, r, L.title);
    const company = pickString(doc, r, L.company);
    const companyHref = pickString(doc, r, L.companyHref);
    const metaPick = pickMeta(doc, r, L.meta);
    const pillPick = pickPills(doc, r, L.pills);
    const insight = pickString(doc, r, L.insight || []);
    const meta = N().classifyMeta(metaPick.spans);
    const pills = N().classifyPills(pillPick.texts);
    const loc = N().splitLocation(meta.location);
    const sections = N().parseSections(description);
    const keyValues = N().parseKeyValueFields(description); // explicit "Employment Type: ..." lines (fallback only)
    const when = now || new Date();

    // Application status: closed notice wins; open needs the Apply button; otherwise unknown (empty).
    const noticeEls = nodes(doc, S().closedNotice, r);
    const noticeText = noticeEls.length ? str(doc, S().closedNoticeText, r) : "";
    const applyButtons = nodes(doc, S().applyButton, r).length;
    const applicationMethod = applyButtons ? N().classifyApplyLabel(str(doc, S().applyButtonLabel, r)) : "";
    const applicationUrl = applicationMethod === "external" ? N().externalApplyUrl(str(doc, S().applyLinkHref, r)) : "";
    const facts = N().parseCompanyFacts(nodes(doc, S().companyFacts, r).map((n) => n.textContent), company.value);
    const benefits = nodes(doc, S().benefits, r).map((n) => N().cleanText(n.textContent)).filter((t) => t && t.length <= 200).slice(0, 30);
    let applicationStatus = "";
    let applicationStatusText = "";
    let statusBasis = "no-evidence";
    if (noticeEls.length) {
      if (N().classifyApplicationNotice(noticeText) === "closed") {
        applicationStatus = "closed";
        applicationStatusText = noticeText;
        statusBasis = "closed-notice";
      } else {
        statusBasis = "notice-text-unrecognized"; // a notice exists but does not say applications are closed
      }
    } else if (applyButtons) {
      applicationStatus = "open";
      statusBasis = "apply-button";
    }
    res.checks.applicationStatusBasis = statusBasis;
    const url = hrefUrl || N().canonicalJobUrl(`/jobs/view/${jobId}/`);
    // Salary: a pay pill shown by LinkedIn wins over a figure found in the description text.
    const salaryFromText = pills.salary ? "" : N().parseSalary(description);
    const salary = pills.salary || salaryFromText;
    const salaryDetails = N().parseSalaryDetails(salary);
    const workplaceType = pills.workplaceType || loc.workplaceType || keyValues.workplaceType;
    const employmentType = pills.employmentType || keyValues.employmentType;

    res.sources = {
      jobId: aboutId ? "about-section-id" : hrefId ? "title-link" : "page-url",
      url: hrefUrl ? "title-link" : "job-id",
      title: title.source,
      company: company.source,
      companyUrl: companyHref.source,
      location: meta.location ? metaPick.source : null,
      postedText: meta.postedText ? metaPick.source : null,
      applicantsText: meta.applicantsText ? metaPick.source : null,
      workplaceType: pills.workplaceType ? pillPick.source : loc.workplaceType ? metaPick.source : keyValues.workplaceType ? "description-key-line" : null,
      employmentType: pills.employmentType ? pillPick.source : keyValues.employmentType ? "description-key-line" : null,
      seniorityLevel: pills.seniorityLevel ? pillPick.source : null,
      applicationStatus: applicationStatus ? statusBasis : null,
      applicationMethod: applicationMethod ? "apply-button-label" : null,
      applicationUrl: applicationUrl ? "apply-link-href" : null,
      benefits: benefits.length ? "benefits-found-in-job-post" : null,
      industry: facts.industry ? "about-the-company" : null,
      companySize: facts.companySize ? "about-the-company" : null,
      hiringInsight: insight.value ? insight.source : null,
      country: N().countryFromLocation(loc.location) ? "location-text" : null,
      salary: pills.salary ? pillPick.source : salaryFromText ? "description-text" : null,
      description: "about-section-expandable-text",
    };
    res.counts = {
      ...res.counts, title: title.counts, company: company.counts, meta: metaPick.counts, pills: pillPick.counts, insight: insight.counts, description: 1,
      applicationClosedNotice: noticeEls.length, applyButton: applyButtons,
    };

    const job = {
      source: "detail",
      jobId,
      url,
      title: title.value,
      company: company.value,
      companyUrl: N().canonicalCompanyUrl(companyHref.value, base) || "",
      location: loc.location,
      country: N().countryFromLocation(loc.location), // only when the location text names a country
      postedText: meta.postedText,
      postedDateApprox: N().parseRelativeDate(meta.postedText, when) || "",
      applicantsText: meta.applicantsText,
      workplaceType,
      employmentType,
      seniorityLevel: pills.seniorityLevel, // only from a pill with LinkedIn's exact seniority wording
      applicationStatus, // "open" | "closed" | "" (unknown)
      applicationStatusText,
      applicationMethod, // "easy_apply" | "external" | "" (no Apply button seen)
      applicationUrl, // employer URL from the external Apply link (read from its href, never opened)
      benefits, // LinkedIn's "Benefits found in job post" list
      industry: facts.industry, // from "About the company"
      companySize: facts.companySize,
      hiringInsight: insight.value,
      otherPills: pills.otherPills,
      description,
      salary, // pill, else a pay figure in the description text
      salaryCurrency: salaryDetails.currency, // only when the salary text names it unambiguously
      salaryPeriod: salaryDetails.period,
      experience: N().parseExperience(description), // heuristic
      responsibilities: sections.responsibilities, // heuristic: heading-based
      qualifications: sections.qualifications, // heuristic: heading-based
      preferredQualifications: sections.preferredQualifications, // heuristic: "Preferred / Nice to have" headings
      education: N().parseEducation(description, sections.education), // lines that name a degree / Education section
      certifications: N().parseCertifications(description, sections.certifications),
      skills: N().parseSkills(description), // heuristic: only explicit "Skills:" lines
      collectedAt: when.toISOString(),
    };
    // DOM-sourced fields only: a failure here means a selector found nothing (even if the description's explicit
    // "Employment Type: ..." line later supplied a value).
    const fromDom = { ...job, workplaceType: pills.workplaceType || loc.workplaceType, employmentType: pills.employmentType };
    for (const f of ["title", "company", "location", "postedText", "applicantsText", "workplaceType", "employmentType"]) {
      if (!fromDom[f]) res.failed.push(f);
    }
    // Selector matched an element but produced no text: the content is there, the selector needs attention.
    const selectorIssues = [];
    for (const [f, pick] of [["title", title], ["company", company], ["hiringInsight", insight]]) {
      if (!pick.value && Object.values(pick.counts).some((n) => n > 0)) selectorIssues.push(f);
    }
    if (!metaPick.spans.length && Object.values(metaPick.counts).some((n) => n > 0)) selectorIssues.push("meta");
    if (applyButtons && !applicationMethod) selectorIssues.push("applicationMethod");
    res.selectorIssues = selectorIssues;
    const g = grade(job, selectorIssues);
    job.extractionStatus = g.status;
    job.extractionWarnings = g.warnings;
    return { ...res, reason: "ok", job };
  }

  // ---- Diagnostics: counts, selector names and missing-field names only; no page text. ----
  function diagnose(doc, pageUrl) {
    const sel = S();
    const base = pageUrl || (doc.location && doc.location.href) || "";
    const cards = nodes(doc, sel.card);
    let withId = 0, noTitle = 0, noCompany = 0, noLocation = 0;
    for (const c of cards) {
      if (str(doc, sel.cardId, c)) withId++;
      if (!str(doc, sel.cardTitle, c)) noTitle++;
      if (!str(doc, sel.cardCompany, c)) noCompany++;
      if (!str(doc, sel.cardLocation, c)) noLocation++;
    }
    const d = extractDetail(doc, new Date(), base);
    const missing = [];
    if (d.job) {
      for (const f of [...CORE_FIELDS, ...EXPECTED_FIELDS, ...OPTIONAL_FIELDS]) if (isBlank(d.job[f])) missing.push(f);
    }
    return {
      layout: d.layout,
      cards: { count: cards.length, withId, missingTitle: noTitle, missingCompany: noCompany, missingLocation: noLocation },
      detail: {
        rootMatches: nodes(doc, sel.detailRoot).length,
        reason: d.reason,
        checks: d.checks,
        selectorMatchCounts: d.counts,
        fieldSources: d.sources,
        failedSelectors: d.failed,
        selectorIssues: d.selectorIssues || [],
        missing,
        extractionStatus: d.job ? d.job.extractionStatus : "failed",
      },
    };
  }

  // The open job's own list card (same job ID, never another job) may carry list fields the detail view did not
  // render. Fill only blank fields from it, record that they came from the card, and grade the result again.
  const CARD_FALLBACK_FIELDS = ["title", "company", "location", "country", "workplaceType"];
  function withCardFallback(detailResult, cards) {
    const job = detailResult && detailResult.job;
    if (!job) return detailResult;
    const card = (cards || []).find((c) => c && c.jobId === job.jobId);
    if (!card) return detailResult;
    const filled = [];
    for (const f of CARD_FALLBACK_FIELDS) if (isBlank(job[f]) && !isBlank(card[f])) { job[f] = card[f]; filled.push(f); }
    if (!filled.length) return detailResult;
    for (const f of filled) detailResult.sources[f] = "job-card";
    const g = grade(job, detailResult.selectorIssues || []);
    job.extractionStatus = g.status;
    job.extractionWarnings = g.warnings;
    return detailResult;
  }

  // Field-by-field completeness of one extraction result (names only, no page text).
  function completeness(detailResult, cards) {
    const job = detailResult && detailResult.job;
    const all = [...CORE_FIELDS, ...EXPECTED_FIELDS, ...OPTIONAL_FIELDS];
    const cardFields = ["jobId", "url", "title", "company", "location", "country", "workplaceType"];
    const cardList = cards || [];
    return {
      detail: job
        ? {
            status: job.extractionStatus,
            found: all.filter((f) => !isBlank(job[f])),
            missingCore: CORE_FIELDS.filter((f) => isBlank(job[f])),
            missingExpected: EXPECTED_FIELDS.filter((f) => isBlank(job[f])),
            notStatedOnPage: OPTIONAL_FIELDS.filter((f) => isBlank(job[f])),
            selectorIssues: detailResult.selectorIssues || [],
            warnings: job.extractionWarnings,
          }
        : { status: "failed", reason: detailResult ? detailResult.reason : "no-detail", found: [], missingCore: CORE_FIELDS.slice() },
      cards: {
        count: cardList.length,
        status: cardList.length ? "partial (card-only)" : "none",
        fieldsFound: cardFields.filter((f) => cardList.some((c) => !isBlank(c[f]))),
        cardsMissing: Object.fromEntries(["title", "company", "location"].map((f) => [f, cardList.filter((c) => isBlank(c[f])).length])),
        detailOnlyFields: DETAIL_ONLY_FIELDS,
      },
    };
  }

  LJS.extractor = {
    extractCards, extractCard, extractDetail, diagnose, detectLayout, readStructuredText, completeness, withCardFallback,
    fields: Object.freeze({ core: CORE_FIELDS, expected: EXPECTED_FIELDS, optional: OPTIONAL_FIELDS, detailOnly: DETAIL_ONLY_FIELDS }),
  };

  if (typeof module !== "undefined" && module.exports) module.exports = LJS;
})(typeof globalThis !== "undefined" ? globalThis : this);
