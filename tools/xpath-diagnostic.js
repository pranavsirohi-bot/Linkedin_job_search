// DevTools diagnostic: paste into the Console on a LinkedIn page.
// READ-ONLY. It never touches cookies, storage, or network, and only prints
// structural info (tag names, attribute NAMES, and a few whitelisted attributes).
//
// Usage:
//   1) Paste this whole file into the Console.
//   2) ljsInspect()                 -> structural overview of the page (job links, data-* attribute names)
//   3) ljsXPath('//a[contains(@href,"/jobs/view/")]')   -> test any XPath you want
//   4) ljsOuterHTML($0, 3000)       -> sanitized HTML of the element selected in the Elements panel ($0)
(() => {
  const SAFE_ATTRS = new Set(["class", "id", "role", "href", "data-job-id", "data-occludable-job-id",
    "data-entity-urn", "aria-label", "aria-current", "data-test-id", "data-view-name", "componentkey"]);

  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    attrNames: [...el.attributes].map((a) => a.name),
    safeAttrs: Object.fromEntries(
      [...el.attributes].filter((a) => SAFE_ATTRS.has(a.name)).map((a) => [a.name, a.value.slice(0, 200)])
    ),
    text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120),
  });

  window.ljsXPath = (xpath, root = document) => {
    const out = [];
    try {
      const r = document.evaluate(xpath, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < r.snapshotLength; i++) {
        const n = r.snapshotItem(i);
        out.push(n.nodeType === 1 ? describe(n) : { nodeType: n.nodeType, value: String(n.nodeValue).slice(0, 200) });
      }
      console.log(`XPath matched ${r.snapshotLength} node(s):`, xpath);
      console.table(out.slice(0, 25));
    } catch (e) {
      console.error("Invalid XPath:", e.message);
    }
    return out;
  };

  window.ljsOuterHTML = (el, max = 3000) => {
    if (!el) return console.warn("Select an element in the Elements panel first, then pass $0.");
    const clone = el.cloneNode(true);
    clone.querySelectorAll("img,svg,script,style,input").forEach((n) => n.remove());
    const html = clone.outerHTML.replace(/\s+/g, " ").slice(0, max);
    console.log(html);
    return html;
  };

  window.ljsInspect = () => {
    const jobLinks = [...document.querySelectorAll('a[href*="/jobs/view/"]')];
    console.log("URL path:", location.pathname);
    console.log("Links to /jobs/view/:", jobLinks.length);
    console.table(jobLinks.slice(0, 5).map((a) => ({
      href: a.getAttribute("href").split("?")[0],
      text: a.textContent.trim().replace(/\s+/g, " ").slice(0, 80),
      parentTag: a.parentElement?.tagName.toLowerCase(),
      parentClass: (a.parentElement?.className || "").toString().slice(0, 100),
    })));
    const dataAttrs = new Map();
    document.querySelectorAll("*").forEach((el) =>
      [...el.attributes].forEach((a) => {
        if (/^data-(job|occludable|entity|view|test)/.test(a.name)) dataAttrs.set(a.name, (dataAttrs.get(a.name) || 0) + 1);
      })
    );
    console.log("Relevant data-* attribute names and counts:");
    console.table([...dataAttrs].map(([name, count]) => ({ name, count })));
    console.log("h1 elements:", [...document.querySelectorAll("h1")].map((h) => h.textContent.trim().slice(0, 80)));
  };

  console.log("Loaded. Run ljsInspect(), ljsXPath('<xpath>'), or ljsOuterHTML($0).");
})();
