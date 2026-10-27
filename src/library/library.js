// Saved-jobs page (extension page opened in a tab). Talks only to the service worker through the existing message
// handlers; it never holds a Supabase client or a user id. All text from saved jobs is inserted with textContent,
// never as HTML.
import { MSG } from "../shared/messages.js";
import { safeHttpsUrl } from "../db/job-mapper.js";
import { extractionLabel, methodLabel, periodLabel, providerLabel, statusLabel, warningLabel } from "../export/columns.js";
import { buildExport, downloadBlob, EXPORT_FORMATS, exportFileName, fetchAllJobs } from "../export/export-jobs.js";

const PAGE_SIZE = 25;
const $ = (id) => document.getElementById(id);
const JOB_URL_RE = /^https:\/\/www\.linkedin\.com\/jobs\/view\/\d+\/$/;

const state = { filters: {}, offset: 0, total: 0, request: 0, ready: false, busy: false, expanded: new Set(), confirmDelete: null, byId: new Map() };

// ---------------------------------------------------------------- helpers
async function worker(type, payload = {}) {
  try {
    return (await chrome.runtime.sendMessage({ type, ...payload })) ?? { ok: false, error: { code: "UNKNOWN", message: "No response from the extension. Try again." } };
  } catch {
    return { ok: false, error: { code: "UNKNOWN", message: "Could not reach the extension background. Reload the extension and try again." } };
  }
}

function notice(text, kind = "info") {
  const el = $("notice");
  el.hidden = !text;
  el.className = kind === "info" ? "" : kind;
  el.textContent = text || "";
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (iso) => (iso ? String(iso).slice(0, 10) : "");

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("data-") || k === "title" || k === "scope" || k === "colspan" || k === "type" || k === "aria-label" || k === "rel" || k === "target") node.setAttribute(k, v);
    else node[k] = v;
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

// Only safe URLs become links; anything else is shown as plain text. LinkedIn rows must be genuine LinkedIn job
// URLs; other providers' postings may be any well-formed https URL (no credentials, no spaces, no javascript:).
function safeJobUrl(job) {
  const url = job && job.url;
  if (typeof url !== "string") return null;
  if (!job.provider || job.provider === "linkedin") return JOB_URL_RE.test(url) ? url : null;
  return safeHttpsUrl(url);
}

function setBusy(busy) {
  state.busy = busy;
  for (const id of ["btn-search", "btn-reset", "btn-export-filtered", "btn-export-all", "btn-prev", "btn-next"]) $(id).disabled = busy;
}

// ---------------------------------------------------------------- filters
function readFilters() {
  const f = {};
  const text = (id) => $(id).value.trim();
  if (text("f-query")) f.query = text("f-query");
  if (text("f-company")) f.company = text("f-company");
  if (text("f-location")) f.location = text("f-location");
  if ($("f-workplace").value) f.workplaceType = $("f-workplace").value;
  if ($("f-employment").value) f.employmentType = $("f-employment").value;
  if ($("f-status").value) f.applicationStatus = $("f-status").value;
  if ($("f-detail").value) f.detail = $("f-detail").value;
  const skills = text("f-skills").split(",").map((s) => s.trim()).filter(Boolean);
  if (skills.length) f.skills = skills;
  return f;
}

const hasFilters = (f) => Object.keys(f).length > 0;

// ---------------------------------------------------------------- rendering
function statusBadge(job) {
  const s = job.applicationStatus === "open" || job.applicationStatus === "closed" ? job.applicationStatus : "unknown";
  const tip = [job.applicationStatusText, job.applicationStatusAt ? `checked ${day(job.applicationStatusAt)}` : ""].filter(Boolean).join(" - ");
  return el("span", { class: "badge", "data-status": s, text: statusLabel(s), ...(tip ? { title: tip } : {}) });
}

// "Card only" / "Partial" marker. Complete rows (and old rows with full details) get none, to keep the table calm.
function completenessBadge(job) {
  const label = extractionLabel(job);
  if (!label || label === "Complete" || label.startsWith("Full details")) return null;
  const kind = label.includes("card only") ? "card" : "partial";
  return el("span", { class: "badge", "data-extraction": kind, text: kind === "card" ? "Card only" : "Partial", title: label });
}

function titleCell(job) {
  const label = job.title || "(untitled job)";
  const href = safeJobUrl(job);
  const td = el("td", { class: "title" });
  if (href) td.append(el("a", { href, target: "_blank", rel: "noopener noreferrer", text: label }));
  else td.append(label);
  const badge = completenessBadge(job);
  if (badge) td.append(" ", badge);
  return td;
}

function actionsCell(job) {
  const td = el("td", { class: "actions-cell" });
  const open = state.expanded.has(job.id);
  td.append(el("button", { type: "button", "data-action": "details", "data-id": job.id, text: open ? "Hide" : "Details" }));
  // Open the posting on LinkedIn (only genuine LinkedIn job URLs). With auto-save on, opening it there saves its details.
  const href = job.url && (!job.provider || job.provider === "linkedin") && JOB_URL_RE.test(job.url) ? job.url : null;
  if (href) td.append(el("a", { class: "action-link", href, target: "_blank", rel: "noopener noreferrer", "data-action-link": "open", text: "Open on LinkedIn" }));
  if (state.confirmDelete === job.id) {
    td.append(
      el("button", { type: "button", "data-action": "confirm-delete", "data-id": job.id, text: "Confirm delete" }),
      el("button", { type: "button", "data-action": "cancel-delete", "data-id": job.id, text: "Cancel" })
    );
  } else {
    td.append(el("button", { type: "button", "data-action": "delete", "data-id": job.id, text: "Delete" }));
  }
  return td;
}

function jobRow(job) {
  return el(
    "tr",
    { "data-id": job.id },
    titleCell(job),
    el("td", { text: job.company || "" }),
    el("td", { text: job.location || "" }),
    el("td", { text: job.workplaceType || "" }),
    el("td", { text: job.employmentType || "" }),
    el("td", {}, statusBadge(job)),
    el("td", { text: job.postedDateApprox || job.postedText || "" }),
    el("td", { text: day(job.createdAt) }),
    el("td", { class: "skills", text: (job.skills || []).join(", ") }),
    el("td", { text: providerLabel(job.provider) }),
    actionsCell(job)
  );
}

// The complete stored record, grouped. Empty fields are left out (nothing is shown that the job did not state).
function detailRows(full) {
  const box = el("div", { class: "details-box" });
  const lines = (v) => (Array.isArray(v) ? v.filter(Boolean).join("\n") : "");
  const group = (title, pairs) => {
    const dl = el("dl", { class: "details-grid" });
    for (const [k, v] of pairs) if (v) dl.append(el("dt", { text: k }), el("dd", { text: v }));
    if (dl.childElementCount) box.append(el("h3", { class: "details-heading", text: title }), dl);
  };
  const salary = [full.salary, full.salaryCurrency, periodLabel(full.salaryPeriod)].filter(Boolean).join(" · ");
  group("Job", [
    ["Job ID", full.jobId], ["Job URL", full.url], ["Location", full.location], ["Country", full.country],
    ["Source", providerLabel(full.provider)], ["Posted", [full.postedText, full.postedDateApprox ? `(about ${full.postedDateApprox})` : ""].filter(Boolean).join(" ")],
    ["Company page", full.companyUrl], ["Industry", full.industry], ["Company size", full.companySize],
  ]);
  group("Employment", [
    ["Workplace", full.workplaceType], ["Employment type", full.employmentType], ["Seniority level", full.seniorityLevel], ["Salary", salary],
    ["Other tags", (full.otherPills || []).join(", ")],
  ]);
  group("Application", [
    ["Application status", [statusLabel(full.applicationStatus), full.applicationStatusText].filter(Boolean).join(" - ")],
    ["Status checked", day(full.applicationStatusAt)], ["How to apply", methodLabel(full.applicationMethod)],
    ["Application page", full.applicationUrl],
    ["Applicants", full.applicantsText], ["Hiring insight", full.hiringInsight],
  ]);
  group("Requirements", [
    ["Skills", (full.skills || []).join(", ")], ["Experience", full.experience], ["Education", lines(full.education)],
    ["Certifications", lines(full.certifications)], ["Responsibilities", lines(full.responsibilities)],
    ["Required qualifications", lines(full.qualifications)], ["Preferred qualifications", lines(full.preferredQualifications)],
    ["Benefits", (full.benefits || []).join(", ")],
  ]);
  group("Record", [
    ["Extraction", extractionLabel(full)],
    ["Warnings", (full.extractionWarnings || []).map(warningLabel).join("\n")],
    ["Captured from", full.hasFullDetail ? "Full job details" : !full.provider || full.provider === "linkedin" ? "List card only (open the job and save again for the description)" : "Imported record without a description"],
    ["First saved", day(full.createdAt)], ["Last checked", day(full.collectedAt)], ["Last updated", day(full.updatedAt)],
  ]);
  if (full.description) box.append(el("h3", { class: "details-heading", text: "Full description" }), el("div", { class: "description", text: full.description }));
  return el("tr", { class: "details", "data-details-for": full.id }, el("td", { colspan: "11" }, box));
}

function renderEmpty(kind) {
  const box = $("empty");
  box.hidden = !kind;
  box.textContent = "";
  if (kind === "none") {
    box.append("Nothing saved yet. Open a LinkedIn job, click the extension icon, and use ", el("strong", { text: "Save job" }), ".");
  } else if (kind === "no-match") {
    box.append("No saved jobs match these filters. Use Reset to see everything.");
  }
}

function renderPager() {
  const from = state.total ? state.offset + 1 : 0;
  const to = Math.min(state.offset + PAGE_SIZE, state.total);
  $("page-info").textContent = state.total ? `${from}-${to} of ${state.total}` : "";
  $("btn-prev").disabled = state.busy || state.offset === 0;
  $("btn-next").disabled = state.busy || state.offset + PAGE_SIZE >= state.total;
  $("pager").hidden = state.total <= PAGE_SIZE && state.offset === 0;
}

// ---------------------------------------------------------------- data loading
async function ensureSession() {
  const res = await worker(MSG.AUTH_STATUS);
  if (!res.ok) return { ok: false, message: res.error.message };
  if (!res.configured) return { ok: false, message: `${res.reason} See docs/SUPABASE_SETUP.md.` };
  if (res.sessionReplaced) notice("Your previous private profile could not be restored, so a new one was created. Jobs saved earlier are not accessible from it.", "warn");
  return { ok: true };
}

function showFailure(message) {
  $("rows").textContent = "";
  renderEmpty(null);
  $("summary").textContent = "";
  $("btn-retry").hidden = false;
  notice(message, "error");
}

async function load() {
  const id = ++state.request;
  setBusy(true);
  $("btn-retry").hidden = true;
  $("summary").textContent = "Loading…";
  if (!state.ready) {
    const s = await ensureSession();
    if (id !== state.request) return;
    if (!s.ok) { setBusy(false); return showFailure(s.message); }
    state.ready = true;
  }
  const res = await worker(MSG.LIST_JOBS, { filters: { ...state.filters, limit: PAGE_SIZE, offset: state.offset } });
  if (id !== state.request) return; // a newer search superseded this one
  setBusy(false);
  if (!res.ok) return showFailure(res.error.message);

  if (res.sessionReplaced) notice("Your previous private profile could not be restored, so a new one was created. Jobs saved earlier are not accessible from it.", "warn");
  else if ($("notice").className === "error") notice("");

  state.total = res.total;
  if (res.jobs.length === 0 && state.offset > 0) { state.offset = Math.max(0, state.offset - PAGE_SIZE); return load(); }

  const tbody = $("rows");
  tbody.textContent = "";
  state.byId = new Map(res.jobs.map((j) => [j.id, j]));
  for (const job of res.jobs) tbody.append(jobRow(job));
  $("jobs").hidden = res.jobs.length === 0;
  renderEmpty(res.jobs.length ? null : hasFilters(state.filters) ? "no-match" : "none");
  $("summary").textContent = res.jobs.length ? `${plural(res.total, "saved job")}${hasFilters(state.filters) ? " match" : ""}` : "";
  renderPager();
  for (const job of res.jobs) if (state.expanded.has(job.id)) openDetails(job.id);
}

const rowFor = (id) => [...$("rows").children].find((tr) => tr.dataset.id === id);
const detailsFor = (id) => [...$("rows").children].find((tr) => tr.dataset.detailsFor === id);

async function openDetails(id) {
  const row = rowFor(id);
  if (!row || detailsFor(id)) return;
  const res = await worker(MSG.GET_JOB, { id });
  if (!res.ok) return notice(res.error.message, "error");
  const fresh = rowFor(id);
  if (fresh && state.expanded.has(id) && !detailsFor(id)) fresh.after(detailRows(res.job));
}

function closeDetails(id) {
  const d = detailsFor(id);
  if (d) d.remove();
}

// ---------------------------------------------------------------- events
$("filters").addEventListener("submit", (e) => {
  e.preventDefault();
  state.filters = readFilters();
  state.offset = 0;
  state.expanded.clear();
  load();
});

$("btn-reset").addEventListener("click", () => {
  $("filters").reset();
  state.filters = {};
  state.offset = 0;
  state.expanded.clear();
  load();
});

$("btn-retry").addEventListener("click", () => { state.ready = false; load(); });
$("btn-prev").addEventListener("click", () => { state.offset = Math.max(0, state.offset - PAGE_SIZE); state.expanded.clear(); load(); });
$("btn-next").addEventListener("click", () => { state.offset += PAGE_SIZE; state.expanded.clear(); load(); });

$("rows").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn || state.busy) return;
  const { action, id } = btn.dataset;
  if (action === "details") {
    if (state.expanded.has(id)) { state.expanded.delete(id); closeDetails(id); btn.textContent = "Details"; }
    else { state.expanded.add(id); btn.textContent = "Hide"; await openDetails(id); }
  } else if (action === "delete") {
    state.confirmDelete = id;
    const td = btn.closest("td");
    td.replaceWith(actionsCell(state.byId.get(id) || { id }));
  } else if (action === "cancel-delete") {
    state.confirmDelete = null;
    btn.closest("td").replaceWith(actionsCell(state.byId.get(id) || { id }));
  } else if (action === "confirm-delete") {
    state.confirmDelete = null;
    setBusy(true);
    const res = await worker(MSG.DELETE_JOB, { id });
    setBusy(false);
    if (!res.ok) { await load(); return notice(res.error.message, "error"); } // reload first: load() clears stale errors
    state.expanded.delete(id);
    notice("Job deleted.", "ok");
    load();
  }
});

// ---------------------------------------------------------------- export (read-only)
async function runExport(scope) {
  if (state.busy) return;
  const format = $("export-format").value;
  if (!EXPORT_FORMATS[format]) return;
  const filtered = scope === "filtered";
  setBusy(true);
  notice("Preparing export…", "info");
  try {
    const jobs = await fetchAllJobs(
      async (args) => {
        const res = await worker(MSG.LIST_JOBS, { filters: args });
        if (!res.ok) throw new Error(res.error.message);
        return res;
      },
      filtered ? state.filters : {},
      { onProgress: (done, total) => notice(`Preparing export… ${done} of ${total}`, "info") }
    );
    if (jobs.length === 0) {
      notice(filtered ? "No saved jobs match the current filters, so there is nothing to export." : "You have no saved jobs to export yet.", "warn");
      return;
    }
    const blob = await buildExport(jobs, format);
    const name = exportFileName(format, { filtered });
    downloadBlob(blob, name);
    notice(`Exported ${plural(jobs.length, "job")} to ${name}. Your saved jobs were not changed.`, "ok");
  } catch (err) {
    notice(`Export failed: ${err && err.message ? err.message : err}. Your saved jobs were not changed.`, "error");
  } finally {
    setBusy(false);
    renderPager();
  }
}

// Jobs are saved from the LinkedIn tab while this page stays open. Reload the list whenever the user comes back to it,
// so a job saved meanwhile (e.g. card-only -> full details) is never shown with its old state.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.ready && !state.busy) load();
});

$("btn-export-filtered").addEventListener("click", () => runExport("filtered"));
$("btn-export-all").addEventListener("click", () => runExport("all"));

load();
