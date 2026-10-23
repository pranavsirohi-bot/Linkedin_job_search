// Classify a LinkedIn URL by pathname only. No DOM access, no assumptions about markup.
export function classifyLinkedInUrl(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return "unknown";
  }
  if (url.hostname !== "www.linkedin.com") return "not-linkedin";
  const p = url.pathname;
  if (p === "/" || p.startsWith("/feed")) return "feed";
  if (p.startsWith("/jobs/view/")) return "job-detail";
  if (p.startsWith("/jobs/search") || /* covers /jobs/search-results/ too */p.startsWith("/jobs/collections")) return "job-search";
  if (p.startsWith("/jobs")) return "jobs-home";
  if (p.startsWith("/company/")) return "company";
  if (p.startsWith("/in/")) return "profile";
  return "other";
}
