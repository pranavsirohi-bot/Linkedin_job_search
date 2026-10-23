// DevTools: paste into the Console on linkedin.com/jobs/search-results/ (with one job selected).
// READ-ONLY. Prints match counts and short text samples for each CANDIDATE XPath, grounded in the
// markup you pasted. Run:  ljsRunCandidates()
(() => {
  const xs = (xpath, ctx = document, type = XPathResult.ORDERED_NODE_SNAPSHOT_TYPE) =>
    document.evaluate(xpath, ctx, null, type, null);
  const nodes = (xpath, ctx = document) => {
    const r = xs(xpath, ctx), out = [];
    for (let i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i));
    return out;
  };
  const str = (xpath, ctx = document) => xs(xpath, ctx, XPathResult.STRING_TYPE).stringValue.trim();
  const clip = (s, n = 90) => String(s).replace(/\s+/g, " ").slice(0, n);

  // ---- Candidate selectors (no class names used) ----
  const X = {
    // List side
    card: "//div[@role='button'][starts-with(@componentkey,'job-card-component-ref-')]",
    cardId: "substring-after(@componentkey,'job-card-component-ref-')",
    cardTitleP: ".//p[span[@aria-hidden='true']]",
    cardTitle: ".//p/span[@aria-hidden='true']",
    cardCompany: ".//p[span[@aria-hidden='true']]/parent::div/following-sibling::div[1]/p",
    cardLocation: ".//p[span[@aria-hidden='true']]/parent::div/following-sibling::p[1]",
    // Detail side: innermost lazy-column that contains the About-the-job section
    detailRoot:
      "//div[@data-testid='lazy-column'][.//div[starts-with(@id,'JobDetails_AboutTheJob_')]]" +
      "[not(.//div[@data-testid='lazy-column'][.//div[starts-with(@id,'JobDetails_AboutTheJob_')]])]",
    aboutSection: ".//div[starts-with(@id,'JobDetails_AboutTheJob_')]",
    aboutId: "substring-after(.//div[starts-with(@id,'JobDetails_AboutTheJob_')]/@id,'JobDetails_AboutTheJob_')",
    title: ".//p/a[contains(@href,'/jobs/view/')]",
    company: ".//p/a[contains(@href,'/company/')]",
    // meta line = <p> that follows the title's wrapper div: location · posted · applicants
    metaP: ".//p[a[contains(@href,'/jobs/view/')]]/parent::div/following-sibling::p[1]",
    metaSpans: "./span[normalize-space()]",
    pills:
      ".//a[contains(@href,'/jobs/search-results/?currentJobId=')][not(@aria-label)]//span[not(*)][normalize-space()]",
    description: ".//div[starts-with(@id,'JobDetails_AboutTheJob_')]//span[@data-testid='expandable-text-box']",
  };

  window.ljsRunCandidates = () => {
    console.group("LIST CARDS");
    const cards = nodes(X.card);
    console.log("cards found:", cards.length);
    console.table(cards.slice(0, 5).map((c) => ({
      jobId: str(X.cardId, c),
      title: clip(str(X.cardTitle, c)),
      company: clip(str(X.cardCompany, c)),
      location: clip(str(X.cardLocation, c)),
    })));
    console.groupEnd();

    console.group("DETAIL PANEL");
    const roots = nodes(X.detailRoot);
    console.log("detailRoot matches (want exactly 1):", roots.length);
    const root = roots[0];
    if (!root) { console.warn("No detail root; stop here and report this."); console.groupEnd(); return; }
    const metaP = nodes(X.metaP, root)[0];
    const descEl = nodes(X.description, root)[0];
    const rows = {
      jobIdFromAbout: str(X.aboutId, root),
      titleCount: nodes(X.title, root).length,
      title: clip(str(X.title, root)),
      titleHref: clip(root.ownerDocument.evaluate(X.title + "/@href", root, null, 2, null).stringValue.split("?")[0], 120),
      companyCount: nodes(X.company, root).length,
      company: clip(str(X.company, root)),
      metaSpans: metaP ? nodes(X.metaSpans, metaP).map((s) => clip(s.textContent, 60)).join(" | ") : "(metaP not found)",
      pills: nodes(X.pills, root).map((s) => clip(s.textContent, 40)).join(" | "),
      descriptionFound: !!descEl,
      descriptionLength: descEl ? descEl.textContent.length : 0,
      descriptionStart: descEl ? clip(descEl.textContent, 120) : "",
    };
    console.table(rows);
    console.groupEnd();
    console.log("Current URL params currentJobId:", new URL(location.href).searchParams.get("currentJobId"));
  };

  console.log("Loaded. Run ljsRunCandidates() with one job selected.");
})();
