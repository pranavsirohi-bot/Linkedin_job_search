// XPath selectors for LinkedIn job pages.
//
// EVIDENCE (pasted from the live site, 2026-10-21):
//   - /jobs/search-results/ : card list + selected-job panel. Live diagnostics reported 25 cards and one
//     detail root with title, company, meta line, description and two pills found.
//   - /jobs/view/<id>/      : standalone page. Markup pasted for header, pills, About section.
//     The standalone selectors below are tested against fixtures of that markup, NOT yet on the live site.
// LinkedIn's CSS class names are build-hashed (e.g. "kfe4n"), so NO class names are used.
// Anchors used instead: role, componentkey, id prefixes, data-testid, href patterns, aria-label, structure.
//
// Loaded as a classic content script (global LJS) and as a CommonJS module in tests.
(function (root) {
  const LJS = (root.LJS = root.LJS || {});

  const ABOUT = "starts-with(@id,'JobDetails_AboutTheJob_')";

  // Header row = the company line. Anchored on the company link that carries text, then up to the div that
  // holds the "More options" button. Same shape in both layouts, so the sibling selectors below are shared.
  // Siblings of the row (verified against both pasted headers): title wrapper div > p, empty div, meta <p>,
  // insights div. The pills container is the next sibling of the row's PARENT.
  const HEADER_ROW =
    "(.//a[contains(@href,'/company/')][normalize-space(text())])[1]/ancestor::div[button[@aria-label='More options']][1]";

  const S = {
    // ---- Job card (left list). One card = one repeating element. ----
    // role=button + componentkey prefix; the inner wrapper has the same componentkey but no role,
    // so the role test selects the outer element only.
    card: "//div[@role='button'][starts-with(@componentkey,'job-card-component-ref-')]",
    // Job ID is the suffix of the card's componentkey.
    cardId: "substring-after(@componentkey,'job-card-component-ref-')",
    // Visible title: the aria-hidden span (the sibling span is a screen-reader duplicate).
    cardTitle: ".//p/span[@aria-hidden='true']",
    // Company / location have no stable attribute: located by structure relative to the title <p>.
    cardCompany: ".//p[span[@aria-hidden='true']]/parent::div/following-sibling::div[1]/p",
    cardLocation: ".//p[span[@aria-hidden='true']]/parent::div/following-sibling::p[1]",

    // ---- Job details panel / page ----
    // Innermost lazy-column that contains the "About the job" section (id prefix is job-ID suffixed).
    detailRoot:
      "//div[@data-testid='lazy-column'][.//div[" + ABOUT + "]]" +
      "[not(.//div[@data-testid='lazy-column'][.//div[" + ABOUT + "]])]",
    // Fallback root when no lazy-column wraps the panel: the nearest ancestor of an About section that also holds the
    // job header ("More options" button). Used only if the lazy-column root finds nothing.
    detailRootFallback: "//div[" + ABOUT + "]/ancestor::div[.//button[@aria-label='More options']][1]",
    aboutId: "substring-after(.//div[" + ABOUT + "]/@id,'JobDetails_AboutTheJob_')",
    // Title is the only /jobs/view/ link inside a <p> in the header.
    title: ".//p/a[contains(@href,'/jobs/view/')]",
    titleHref: ".//p/a[contains(@href,'/jobs/view/')]/@href",
    // The company link that carries its own text. The logo wrapper <a> (same href) holds no direct text,
    // and in the live DOM the two anchors are nested, so match on direct text rather than on a <p> parent.
    company: "(.//a[contains(@href,'/company/')][normalize-space(text())])[1]",
    companyHref: "(.//a[contains(@href,'/company/')][normalize-space(text())])[1]/@href",
    // "location · posted · applicants" line: the first <p> that follows the title's row. The title <p> may sit directly in a
    // display-contents <div> (2026-10-21/22 layouts) or inside one more row <div> (2026-10-23 layout), so the row is the
    // NEAREST ancestor <div> that has a following <p> sibling, not simply the parent.
    metaLine: ".//p[a[contains(@href,'/jobs/view/')]]/ancestor::div[following-sibling::p][1]/following-sibling::p[1]",
    metaSpans: "./span[normalize-space()]",
    // Pills (Remote, Full-time, ...): links back to the search URL whose span has text.
    // Their meaning is decided by text vocabulary, not position (see normalize.js).
    pills:
      ".//a[contains(@href,'/jobs/search-results/?currentJobId=')][not(@aria-label)]//span[not(*)][normalize-space()]",
    // Description body; the "… more" button inside it is excluded when reading text.
    description: ".//div[" + ABOUT + "]//span[@data-testid='expandable-text-box']",
    descriptionButton: ".//button[@data-testid='expandable-text-button']",

    // ---- Application status ----
    // CLOSED evidence (markup pasted from a live closed job): a polite-alert <div aria-live="assertive"
    // aria-atomic="true"> holding an icon with aria-label="Error" and a <p> "No longer accepting applications".
    closedNotice: ".//div[@aria-live='assertive'][@aria-atomic='true'][.//*[@aria-label='Error']]",
    closedNoticeText: ".//div[@aria-live='assertive'][@aria-atomic='true'][.//*[@aria-label='Error']]//p",
    // OPEN evidence: the Apply / Easy Apply button (aria-labels "Apply on company website" and
    // "Easy Apply to this job" seen in pasted markup). Open requires this positive signal; absence of the
    // closed notice alone is not enough because the panel may simply not have finished loading.
    // EVIDENCE 2026-10-22 (pasted live search panel, job 4303643872): the external Apply control is a LINK,
    // <a aria-label="Apply on company website" href="https://www.linkedin.com/safety/go/?url=...">, not a <button>.
    // Both element types are accepted.
    applyButton: ".//*[self::button or self::a][starts-with(@aria-label,'Easy Apply') or starts-with(@aria-label,'Apply')]",
    // Its label says HOW to apply: "Easy Apply to this job" (on LinkedIn) or "Apply on company website" (external).
    applyButtonLabel: "(.//*[self::button or self::a][starts-with(@aria-label,'Easy Apply') or starts-with(@aria-label,'Apply')])[1]/@aria-label",
    // The external link's href (LinkedIn's safety redirect carrying the employer URL in ?url=). Read, never followed.
    applyLinkHref: "(.//a[starts-with(@aria-label,'Apply')])[1]/@href",
    // "About the company" facts: every <p> in that section except the expandable description.
    companyFacts: ".//div[starts-with(@id,'JobDetails_AboutTheCompany_')]//p[normalize-space()][not(.//*[@data-testid='expandable-text-box'])]",
    // "Benefits found in job post": LinkedIn's own list under the description (EVIDENCE: hr, <p> heading, <p> items).
    benefits: ".//div[" + ABOUT + "]//p[normalize-space()='Benefits found in job post']/following-sibling::p[normalize-space()]",

    // ---- Insight line under the meta line ----
    // EVIDENCE (both pasted headers): the div right after the meta <p> holds one <p> with LinkedIn's hiring/response
    // insight ("Responses managed off LinkedIn", "No response insights available yet").
    insightLine: ".//p[a[contains(@href,'/jobs/view/')]]/ancestor::div[following-sibling::p][1]/following-sibling::p[1]/following-sibling::div[1][p]",

    // ---- Header-anchored selectors (standalone page primary; search-panel fallback) ----
    // Standalone title is a plain <p> (no link), found as the <p> in the row's next sibling div.
    headerTitle: HEADER_ROW + "/following-sibling::div[1]/p",
    headerMeta: HEADER_ROW + "/following-sibling::p[1]",
    headerPills:
      HEADER_ROW + "/parent::div/following-sibling::div[1]//a[not(@aria-label)]//span[not(*)][normalize-space()]",
    headerInsight: HEADER_ROW + "/following-sibling::p[1]/following-sibling::div[1][p]",
  };
  LJS.selectors = Object.freeze(S);

  // Ordered candidates per field and layout. The extractor takes the first non-empty one and records its
  // name, so diagnostics can say which selector supplied each field. Nothing outside these lists is tried.
  const c = (name, xpath) => Object.freeze({ name, xpath });
  LJS.layouts = Object.freeze({
    "search-results": Object.freeze({
      title: [c("search-title-link", S.title), c("header-anchored", S.headerTitle)],
      titleHref: [c("search-title-link", S.titleHref)],
      company: [c("company-link-text", S.company)],
      companyHref: [c("company-link-text", S.companyHref)],
      meta: [c("title-link-sibling", S.metaLine), c("header-anchored", S.headerMeta)],
      pills: [c("search-results-links", S.pills), c("header-anchored", S.headerPills)],
      insight: [c("title-link-sibling", S.insightLine), c("header-anchored", S.headerInsight)],
    }),
    "standalone-job": Object.freeze({
      title: [c("header-anchored", S.headerTitle)],
      titleHref: [],
      company: [c("company-link-text", S.company)],
      companyHref: [c("company-link-text", S.companyHref)],
      meta: [c("header-anchored", S.headerMeta)],
      pills: [c("header-anchored", S.headerPills)],
      insight: [c("header-anchored", S.headerInsight)],
    }),
  });

  if (typeof module !== "undefined" && module.exports) module.exports = LJS;
})(typeof globalThis !== "undefined" ? globalThis : this);
