// Column definitions shared by CSV and XLSX export. Values are read from the camelCase records returned by the
// data layer (fromRow). Every getter tolerates missing fields and returns a string ("" when empty): nothing is
// invented for a field the job did not state. The header set is documented in docs/FIELDS.md.

const str = (v) => (v == null ? "" : String(v));
const list = (v, sep) => (Array.isArray(v) ? v.map(str).filter(Boolean).join(sep) : "");

const PROVIDER_LABELS = { linkedin: "LinkedIn", greenhouse: "Greenhouse", file: "Imported file" };
export const providerLabel = (p) => PROVIDER_LABELS[p || "linkedin"] || String(p);

export const statusLabel = (s) => (s === "open" ? "Open" : s === "closed" ? "Closed" : "Unknown");

const METHOD_LABELS = { easy_apply: "Easy Apply", external: "External (company website)" };
export const methodLabel = (m) => METHOD_LABELS[m] || "";

const PERIOD_LABELS = { hour: "per hour", day: "per day", week: "per week", month: "per month", year: "per year" };
export const periodLabel = (p) => PERIOD_LABELS[p] || "";

// How complete the stored record is. Rows saved before extraction tracking have no status: they are described by
// what they hold (full details or card only) instead of being given a grade they were never checked for.
export function extractionLabel(j) {
  if (!j) return "";
  if (j.extractionStatus === "complete") return "Complete";
  // Imported / API rows have no list "cards": partial means a field such as the description was missing in the source.
  const linkedIn = !j.provider || j.provider === "linkedin";
  if (j.extractionStatus === "partial") return !linkedIn || j.hasFullDetail || j.source === "detail" ? "Partial" : "Partial (card only)";
  if (j.hasFullDetail || j.source === "detail") return "Full details (not graded)";
  return j.source === "card" && linkedIn ? "Partial (card only)" : "";
}

const FIELD_LABELS = {
  jobId: "job ID", url: "job URL", title: "title", company: "company", location: "location", postedText: "posted date",
  description: "description", workplaceType: "workplace type", employmentType: "employment type", applicantsText: "applicants",
  applicationStatus: "application status", applicationMethod: "application method", hiringInsight: "hiring insight", meta: "location/posted line",
};
// "missing:location" -> "location not found"; "selector-empty:title" -> "title selector matched but read nothing"
export function warningLabel(w) {
  const s = String(w || "");
  if (s === "card-only") return "card only: open the job to capture its description and details";
  const [kind, field] = s.split(":");
  const name = FIELD_LABELS[field] || field || s;
  if (kind === "missing") return `${name} not found`;
  if (kind === "selector-empty") return `${name} selector matched but read nothing`;
  return s;
}

export const EXPORT_COLUMNS = Object.freeze([
  // A. Basic information
  { key: "title", header: "Job title", width: 34, get: (j) => str(j.title) },
  { key: "company", header: "Company", width: 26, get: (j) => str(j.company) },
  { key: "jobId", header: "Job ID", width: 18, get: (j) => str(j.jobId) },
  { key: "url", header: "Job URL", width: 46, get: (j) => str(j.url) },
  { key: "location", header: "Location", width: 24, get: (j) => str(j.location) },
  { key: "country", header: "Country", width: 14, get: (j) => str(j.country) },
  { key: "provider", header: "Source", width: 14, get: (j) => providerLabel(j.provider) },
  { key: "postedText", header: "Posted", width: 14, get: (j) => str(j.postedText) },
  { key: "postedDateApprox", header: "Posted date (approx.)", width: 20, get: (j) => str(j.postedDateApprox) },
  { key: "companyUrl", header: "Company URL", width: 40, get: (j) => str(j.companyUrl) },
  { key: "industry", header: "Industry", width: 28, get: (j) => str(j.industry) },
  { key: "companySize", header: "Company size", width: 18, get: (j) => str(j.companySize) },
  // C. Employment details
  { key: "workplaceType", header: "Workplace type", width: 14, get: (j) => str(j.workplaceType) },
  { key: "employmentType", header: "Employment type", width: 15, get: (j) => str(j.employmentType) },
  { key: "seniorityLevel", header: "Seniority level", width: 16, get: (j) => str(j.seniorityLevel) },
  { key: "salary", header: "Salary", width: 20, get: (j) => str(j.salary) },
  { key: "salaryCurrency", header: "Salary currency", width: 10, get: (j) => str(j.salaryCurrency) },
  { key: "salaryPeriod", header: "Salary period", width: 12, get: (j) => periodLabel(j.salaryPeriod) },
  { key: "otherPills", header: "Other tags", width: 24, get: (j) => list(j.otherPills, "; ") },
  // D. Application information
  { key: "applicationMethod", header: "Application method", width: 22, get: (j) => methodLabel(j.applicationMethod) },
  { key: "applicationUrl", header: "External application URL", width: 46, get: (j) => str(j.applicationUrl) },
  { key: "applicationStatus", header: "Application status", width: 18, get: (j) => statusLabel(j.applicationStatus) },
  { key: "applicationStatusText", header: "Application notice", width: 30, get: (j) => str(j.applicationStatusText) },
  { key: "applicationStatusAt", header: "Status checked at", width: 22, get: (j) => str(j.applicationStatusAt) },
  { key: "applicantsText", header: "Applicants", width: 22, get: (j) => str(j.applicantsText) },
  { key: "hiringInsight", header: "Hiring insight", width: 30, get: (j) => str(j.hiringInsight) },
  // B. Description and qualifications
  { key: "skills", header: "Skills", width: 30, get: (j) => list(j.skills, "; ") },
  { key: "experience", header: "Experience required", width: 24, get: (j) => str(j.experience) },
  { key: "education", header: "Education", width: 36, get: (j) => list(j.education, "\n") },
  { key: "certifications", header: "Certifications", width: 30, get: (j) => list(j.certifications, "\n") },
  { key: "responsibilities", header: "Responsibilities", width: 50, get: (j) => list(j.responsibilities, "\n") },
  { key: "qualifications", header: "Required qualifications", width: 50, get: (j) => list(j.qualifications, "\n") },
  { key: "preferredQualifications", header: "Preferred qualifications", width: 50, get: (j) => list(j.preferredQualifications, "\n") },
  { key: "benefits", header: "Benefits", width: 30, get: (j) => list(j.benefits, "; ") },
  { key: "description", header: "Description", width: 70, get: (j) => str(j.description) },
  // E. Tracking metadata
  { key: "extractionStatus", header: "Extraction status", width: 18, get: (j) => extractionLabel(j) },
  { key: "extractionWarnings", header: "Extraction warnings", width: 40, get: (j) => (Array.isArray(j.extractionWarnings) ? j.extractionWarnings.map(warningLabel).filter(Boolean).join("; ") : "") },
  { key: "source", header: "Captured from", width: 16, get: (j) => (j.hasFullDetail ? "Full details" : j.provider && j.provider !== "linkedin" ? "Imported, no description" : j.source === "detail" ? "Full details" : j.source === "card" ? "List card only" : "") },
  { key: "createdAt", header: "First saved", width: 22, get: (j) => str(j.createdAt) },
  { key: "collectedAt", header: "Last checked", width: 22, get: (j) => str(j.collectedAt) },
  { key: "updatedAt", header: "Last updated", width: 22, get: (j) => str(j.updatedAt) },
]);
