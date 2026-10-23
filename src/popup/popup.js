import { MSG } from "../shared/messages.js";
import { classifyLinkedInUrl } from "../shared/page-type.js";
import { csvBlob } from "../export/csv.js";
import { mappingReport } from "../db/job-mapper.js";
import { downloadBlob, exportFileName, fetchAllJobs } from "../export/download.js";
import { WATCH_KEY, summarizeWatch } from "../watch/watch-session.js";

const $ = (id) => document.getElementById(id);

const PAGE_LABELS = {
  feed: "LinkedIn home feed",
  "job-detail": "LinkedIn job detail page",
  "job-search": "LinkedIn job search results",
  "jobs-home": "LinkedIn Jobs page",
  company: "LinkedIn company page",
  profile: "LinkedIn profile page",
  other: "Other LinkedIn page",
  "not-linkedin": "Not a LinkedIn page",
  unknown: "Unknown page",
};

// watch:    persisted auto-save session from the service worker (the source of truth for progress)
// starting: Start was pressed and the worker has not answered yet
// note:     guidance shown when there is no session to display
const state = { user: null, configured: false, onLinkedIn: false, busy: false, pageUrl: "", tabId: null, watch: null, starting: false, note: null, countedKey: null, automaticSources: [] };

// ---------------------------------------------------------------- helpers
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Service worker request. Never throws: failures come back as { ok:false, error }.
async function worker(type, payload = {}) {
  try {
    return (await chrome.runtime.sendMessage({ type, ...payload })) ?? { ok: false, error: { code: "UNKNOWN", message: "No response from the extension. Try again." } };
  } catch {
    return { ok: false, error: { code: "UNKNOWN", message: "Could not reach the extension background. Reload the extension and try again." } };
  }
}

// Content script request (read-only extraction of the page the user is looking at).
async function page(type, extra = {}) {
  const tab = await activeTab();
  return chrome.tabs.sendMessage(tab.id, { type, ...extra });
}

function show(obj) {
  const out = $("output");
  out.hidden = false;
  out.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
}

function status(text, kind = "info") {
  const el = $("status");
  el.hidden = !text;
  el.className = kind === "info" ? "" : kind;
  el.textContent = text || "";
}

function setBusy(busy, label) {
  state.busy = busy;
  for (const id of ["btn-save-job", "btn-download-csv", "btn-retry"]) $(id).disabled = busy;
  if (!busy) renderAccount(); // re-apply page-dependent enablement
  renderRun();
  if (busy && label) status(label, "info");
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- page status
async function showPageStatus() {
  const el = $("page-status");
  try {
    const tab = await activeTab();
    const type = classifyLinkedInUrl(tab?.url ?? "");
    state.pageUrl = tab?.url ?? "";
    state.tabId = Number.isInteger(tab?.id) ? tab.id : null;
    state.onLinkedIn = type !== "not-linkedin" && type !== "unknown";
    let text = PAGE_LABELS[type] ?? PAGE_LABELS.unknown;
    if (state.onLinkedIn) {
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { type: MSG.GET_PAGE_INFO });
        text += res?.ok ? " — content script connected" : " — no response";
      } catch {
        text += " — content script not active (reload the tab)";
      }
    }
    el.textContent = text;
  } catch (err) {
    el.textContent = "Could not read current tab.";
    console.error("[LJS]", err);
  }
  $("tools").hidden = !state.onLinkedIn;
}

// ---------------------------------------------------------------- profile (anonymous session, owned by the service worker)
const REPLACED_NOTE =
  "Your previous private profile could not be restored, so a new one was created. Jobs saved earlier are not accessible from it.";

function renderAccount() {
  const { configured, user } = state;
  const ready = !!(configured && user);
  $("profile").hidden = !ready;
  $("collect-section").hidden = !ready;
  $("download-section").hidden = !ready;
  if (!state.busy) $("btn-download-csv").disabled = false;
  if (ready && !state.onLinkedIn && !state.note && !state.watch) state.note = { text: "Open a LinkedIn jobs page (search results or a job), then press Start.", kind: "warn" };
  if (user) $("profile-id").textContent = `(${user.id.slice(0, 8)}…)`;
  renderRun();
}

function showSetupFailure(message) {
  state.user = null;
  $("account-note").hidden = false;
  $("account-note").textContent = message;
  $("btn-retry").hidden = false;
  renderAccount();
}

// Reuses the stored session; creates one only when none exists. Shows a loading state meanwhile.
async function refreshAccount() {
  $("btn-retry").hidden = true;
  $("account-note").hidden = false;
  $("account-note").textContent = "Setting up your private profile…";
  $("btn-retry").disabled = true;
  const res = await worker(MSG.AUTH_STATUS);
  $("btn-retry").disabled = false;
  if (!res.ok) return showSetupFailure(res.error.message);

  state.configured = res.configured;
  state.user = res.user;
  if (!res.configured) {
    $("account-note").textContent = `${res.reason} See docs/SUPABASE_SETUP.md. Preview and diagnostics still work.`;
    return renderAccount();
  }
  $("account-note").hidden = true;
  renderAccount();
  if (res.sessionReplaced) status(REPLACED_NOTE, "warn");
  refreshCount();
}

async function refreshCount() {
  const res = await worker(MSG.COUNT_SAVED);
  $("saved-count").textContent = res.ok ? String(res.count) : "–";
  if (res.ok && res.sessionReplaced) status(REPLACED_NOTE, "warn");
}

$("btn-retry").addEventListener("click", refreshAccount);

// The saved-jobs table (search, filters, export) is a full extension page opened in its own tab.
$("btn-open-library").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/library/library.html") });
});

// ---------------------------------------------------------------- reading the page (read-only)
async function readPage(waitForDetailMs = 0) {
  try {
    const res = await page(MSG.EXTRACT_PREVIEW, waitForDetailMs ? { waitForDetailMs } : {});
    return res?.ok ? res : { ok: false, message: res?.error || "The page could not be read." };
  } catch {
    return { ok: false, message: "Content script not active. Reload the LinkedIn tab and try again." };
  }
}

// The open job's panel can still be rendering when the user clicks (LinkedIn loads the description after the header).
// The content script waits for the details to actually appear (checked every 150 ms, at most this long) and only
// returns the job whose panel matches the selected job.
const OPEN_JOB_WAIT_MS = 4000;
const readOpenJob = () => readPage(OPEN_JOB_WAIT_MS);

const REASON_TEXT = {
  "description-not-loaded": "the job's description has not loaded yet",
  "description-empty": "the job's description is empty",
  "panel-loading-id-mismatch": "the panel is still switching between two jobs",
  "page-id-mismatch": "the panel still shows a different job than the one selected",
  "ambiguous-detail-root": "several job panels are on the page and none matches the selected job",
  "no-detail-panel": "no job details panel is open",
  "no-job-id": "the open job has no readable job ID",
  "unsupported-layout": "this is not a LinkedIn jobs page",
};

function failSave(res, extracted) {
  // Keep what was read so the user can see it and retry; nothing is lost.
  show({ notSaved: true, extracted });
  const p = res.error.partial;
  const partial = p && (p.inserted || p.duplicates) ? ` ${p.inserted} saved before the error.` : "";
  if (res.error.code === "AUTH_REQUIRED" || res.error.code === "AUTH_FAILED") $("btn-retry").hidden = false;
  return `${res.error.message}${partial}`;
}

// ---------------------------------------------------------------- Start / Stop: auto-save while the user browses
// Start turns on auto-save for this LinkedIn tab. From then on the service worker saves the jobs on every page the
// USER opens in that tab (clicking Next, scrolling, opening a job), a few at a time, until Stop. This popup only
// displays the persisted session state, so closing it neither stops nor loses anything. The extension never clicks,
// scrolls, opens or navigates anything on LinkedIn.
const isWatching = (w) => !!w && w.status === "watching";
const END_TEXT = {
  "tab-closed": "Stopped because the LinkedIn tab was closed.",
  "browser-restarted": "Stopped because the browser restarted.",
  "extension-reloaded": "Stopped because the extension was reloaded or updated.",
};

function watchText(w) {
  const c = w.counters;
  const tally = `${plural(c.saved, "new job")} saved, ${c.duplicates} already saved (updated), ${c.skipped} skipped, ${c.partial || 0} partial, ${c.failed} failed`;
  if (isWatching(w)) {
    if (w.current === "reading") return { text: "Reading the page you opened...", kind: "" };
    if (w.current === "saving") return { text: w.saveCards ? `Saving... ${c.processed} of ${c.discovered} processed.` : `Saving... ${c.processed} processed.`, kind: "" };
    const lead = c.processed ? `Auto-save is on: ${tally}.` : "Auto-save is on.";
    const how = w.saveCards ? "Keep browsing: open jobs or click Next yourself and they are saved automatically." : "Click the next job in the LinkedIn list; it is saved with full details once it appears.";
    return { text: `${lead} ${how} Press Stop to end.`, kind: "ok" };
  }
  const why = END_TEXT[w.endReason] || "Stopped by you.";
  return { text: `${why} ${tally} from ${plural(c.pages, "page")}. Jobs saved so far are kept.`, kind: "warn" };
}

function renderRun() {
  const w = state.watch;
  const on = isWatching(w);
  const otherTab = on && state.tabId !== null && w.tabId !== state.tabId;

  $("btn-start").textContent = "Start";
  $("btn-start").disabled = state.busy || state.starting || on || !state.onLinkedIn;
  $("btn-stop").disabled = state.starting || !on;
  $("btn-save-job").disabled = state.busy || state.starting || !state.onLinkedIn;

  const c = w ? w.counters : { pages: 0, discovered: 0, processed: 0, saved: 0, duplicates: 0, full: 0, skipped: 0, partial: 0, failed: 0 };
  $("k-full").textContent = String(c.full || 0);
  $("k-pages").textContent = String(c.pages);
  $("k-discovered").textContent = String(c.discovered);
  $("k-processed").textContent = String(c.processed);
  $("k-saved").textContent = String(c.saved);
  $("k-existing").textContent = String(c.duplicates);
  $("k-skipped").textContent = String(c.skipped);
  $("k-partial").textContent = String(c.partial || 0);
  $("k-failed").textContent = String(c.failed);
  // Progress: with cards, saved vs discovered; without, jobs on this page saved with full details.
  const pg = (w && w.page) || { visible: 0, full: 0 };
  const pct = !w ? 0 : w.saveCards ? (c.discovered ? Math.min(100, Math.round((100 * c.processed) / c.discovered)) : 0) : pg.visible ? Math.round((100 * pg.full) / pg.visible) : 0;
  $("collect-fill").style.width = `${pct}%`;
  $("collect-bar").setAttribute("aria-valuenow", String(pct));

  let line;
  if (state.starting) line = { text: "Starting auto-save...", kind: "" };
  else if (w) line = watchText(w);
  else line = state.note || { text: "Not started.", kind: "" };
  $("collect-status").textContent = line.text;
  $("collect-status").className = `run-status${line.kind ? ` ${line.kind}` : ""}`;

  // Never claim automatic iteration that does not exist: say exactly what is automatic and what is not.
  $("collect-auto").textContent = state.automaticSources.length
    ? `Automatic collection is available from: ${state.automaticSources.map((s) => s.label).join(", ")}.`
    : "Automatic job-to-job or page-to-page collection is not available: no authorised job-data source is configured, and LinkedIn is never clicked or paged automatically. Open each job yourself; it is saved with its full details.";
  const job = on && !otherTab ? openJobLine(w) : null;
  $("collect-job").hidden = !job;
  $("job-state").textContent = job ? job.state : "";
  $("job-name").textContent = job ? job.name : "";
  const guide = on && !otherTab ? guideText(w) : "";
  $("collect-guide").hidden = !guide;
  $("collect-guide").textContent = guide;
  $("opt-save-cards").disabled = on || state.starting;

  $("collect-detail").hidden = !on;
  $("collect-detail").textContent = !on ? "" : otherTab
    ? "Auto-save is on for another LinkedIn tab. Switch to it to keep collecting, or press Stop."
    : w.saveCards ? "List cards carry no description: open a job to save its full details." : "Only the jobs you open are saved, always with their full details.";
  const err = on && w.lastError ? w.lastError.message : "";
  $("collect-error").hidden = !err;
  $("collect-error").textContent = err ? `Last problem: ${err}` : "";

  // Refresh the saved-jobs total after each finished save pass, and once when the session ends.
  const key = w && (!on || w.current === "watching") ? `${w.sessionId}:${c.processed}:${w.status}` : null;
  if (key && key !== state.countedKey) {
    state.countedKey = key;
    if (state.user && c.processed) refreshCount();
  }
}

// The open job: its title / company and where it is in the pipeline. Shown while auto-save runs.
const JOB_STATE_TEXT = {
  found: "Extracting",
  saving: "Saving",
  full: "Full details saved",
  partial: "Partial",
  failed: "Failed",
  loading: "Extracting (details still loading)",
  unreadable: "Failed",
};
function openJobLine(w) {
  const j = w.openJob;
  if (!j) return { state: w.current === "reading" ? "Extracting" : "Waiting for job", name: "Click a job in the LinkedIn list." };
  const state = w.current === "reading" && j.state === "found" ? "Extracting" : JOB_STATE_TEXT[j.state] || j.state;
  const name = j.jobId ? `${j.title || j.jobId}${j.company ? ` - ${j.company}` : ""}` : j.state === "unreadable" ? `could not read the open job (${j.reason})` : "";
  return { state: `${state}:`, name };
}

// Guided checklist: this page's progress and the next job to open, from the confirmed save state (this session and the
// database). The user clicks the suggested job in LinkedIn; the extension never clicks it.
function guideText(w) {
  const pg = w.page;
  if (!pg || !pg.visible) return "";
  const parts = [`This page: ${pg.full} of ${plural(pg.visible, "job")} saved with full details.`];
  if (pg.next) parts.push(`Next to save: ${pg.next.title || pg.next.jobId}${pg.next.company ? ` - ${pg.next.company}` : ""} (marked "Next to save" in the list; click it yourself).`);
  else parts.push("All jobs on this page are saved. Go to the next results page yourself to continue.");
  return parts.join(" ");
}

function note(text, kind = "") {
  state.note = { text, kind };
  renderRun();
}

// Replies and live storage updates can arrive out of order: never replace a newer view of the same session.
function setWatch(w) {
  const cur = state.watch;
  if (w && cur && w.sessionId === cur.sessionId && (w.rev || 0) < (cur.rev || 0)) return;
  state.watch = w;
}

async function refreshWatch() {
  const res = await worker(MSG.WATCH_STATUS);
  if (res.ok) {
    if (Array.isArray(res.automaticSources)) state.automaticSources = res.automaticSources;
    setWatch(res.watch);
    renderRun();
  }
}

async function runStart() {
  if (state.busy || state.starting || isWatching(state.watch)) return;
  if (!state.onLinkedIn || state.tabId === null) return note("Open a LinkedIn jobs page (search results or a job), then press Start.", "warn");
  if (!navigator.onLine) return note("You're offline. Nothing was saved; try again when you're connected.", "error");
  status("");
  state.note = null;
  state.starting = true;
  renderRun();
  const saveCards = $("opt-save-cards").checked;
  savePref({ saveCards });
  const res = await worker(MSG.WATCH_START, { tabId: state.tabId, pageUrl: state.pageUrl, saveCards });
  state.starting = false;
  if (!res.ok) return note(res.error.message, "error");
  setWatch(res.watch);
  renderRun();
}

async function runStop() {
  const w = state.watch;
  if (!isWatching(w)) return;
  $("btn-stop").disabled = true; // acknowledged immediately; the worker starts no further batch
  const res = await worker(MSG.WATCH_STOP, { sessionId: w.sessionId });
  if (!res.ok) note(res.error.message, res.error.code === "stale-session" ? "warn" : "error");
  else setWatch(res.watch);
  renderRun();
}

// The "Also save list cards" choice is remembered (a per-browser convenience; default off).
const PREFS_KEY = "ljs:prefs";
async function loadPrefs() {
  try {
    const r = await chrome.storage.local.get(PREFS_KEY);
    $("opt-save-cards").checked = !!(r && r[PREFS_KEY] && r[PREFS_KEY].saveCards === true);
  } catch { /* default: off */ }
}
function savePref(p) {
  try { chrome.storage.local.set({ [PREFS_KEY]: p }).catch(() => {}); } catch { /* not remembered */ }
}

$("btn-start").addEventListener("click", runStart);
$("btn-stop").addEventListener("click", runStop);

// Live progress: the worker writes the session to chrome.storage.local after every step.
if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && WATCH_KEY in changes) {
      setWatch(summarizeWatch(changes[WATCH_KEY].newValue));
      renderRun();
    }
  });
}
const poll = setInterval(() => { if (isWatching(state.watch)) refreshWatch(); }, 1500); // fallback
window.addEventListener("pagehide", () => clearInterval(poll));

// ---------------------------------------------------------------- Save open job only (single job, full details)
async function saveOpenJob() {
  if (state.busy) return;
  if (!navigator.onLine) return status("You're offline. Nothing was saved; try again when you're connected.", "error");
  setBusy(true, "Reading page…");
  const ex = await readOpenJob();
  if (!ex.ok) { setBusy(false); return status(ex.message, "error"); }
  if (!ex.detail) {
    setBusy(false);
    const why = REASON_TEXT[ex.detailReason] || "the job could not be read";
    return status(`Nothing saved: ${why} (${ex.detailReason}). Open the job in the list, wait until "About the job" is shown, then try again. Preview extraction shows the details.`, "warn");
  }
  const warnings = ex.failedSelectors || [];
  status("Saving 1 job…", "info");
  const res = await worker(MSG.SAVE_JOBS, { jobs: [ex.detail] });
  setBusy(false);
  if (!res.ok) return status(failSave(res, ex.detail), "error");

  const r = res.result;
  const parts = [];
  if (r.inserted) parts.push(`${plural(r.inserted, "new job")} saved`);
  if (r.duplicates) parts.push(`${plural(r.duplicates, "duplicate")} (already saved, updated)`);
  if (!parts.length) parts.push("Nothing was saved");
  let text = parts.join(", ") + ".";
  if (r.rejected?.length) text += ` ${plural(r.rejected.length, "record")} skipped (incomplete).`;
  if (warnings.length) text += ` Couldn't read: ${warnings.join(", ")}.`;
  if (ex.detail.applicationStatus === "closed") text += " This job is no longer accepting applications.";
  else if (ex.detail.applicationStatus === "open") text += " Applications are open.";
  if (ex.detail.extractionStatus === "partial") text += ` Partial extraction (${(ex.detail.extractionWarnings || []).filter((w) => w.startsWith("missing:")).map((w) => w.slice(8)).join(", ")} not found).`;
  const schema = await worker(MSG.SCHEMA_STATUS);
  if (schema.ok && !schema.detailColumns) text += " Extra details (country, salary currency/period, application method, education, certifications, extraction status) are stored once the database update is applied.";
  if (res.sessionReplaced) status(`${text} ${REPLACED_NOTE}`, "warn");
  else status(text, r.inserted || r.duplicates ? "ok" : "warn");
  refreshCount();
}

$("btn-save-job").addEventListener("click", saveOpenJob);

// ---------------------------------------------------------------- Download CSV of every saved job
async function downloadCsv() {
  if (state.busy) return;
  const line = $("download-status");
  setBusy(true);
  line.textContent = "Preparing CSV…";
  try {
    const jobs = await fetchAllJobs(
      async (args) => {
        const res = await worker(MSG.LIST_JOBS, { filters: args });
        if (!res.ok) throw new Error(res.error.message);
        return res;
      },
      {},
      { onProgress: (done, total) => { line.textContent = `Preparing CSV… ${done} of ${total}`; } }
    );
    if (!jobs.length) {
      line.textContent = "You have no saved jobs yet. Open LinkedIn job results and press Start first.";
      return;
    }
    const name = exportFileName("csv");
    downloadBlob(csvBlob(jobs), name);
    const withDescription = jobs.filter((j) => j.description).length;
    line.textContent = `Downloaded ${plural(jobs.length, "job")} to ${name} (${withDescription} with a full description). Your saved jobs were not changed.`;
  } catch (err) {
    line.textContent = `Download failed: ${err && err.message ? err.message : err}. Your saved jobs were not changed.`;
  } finally {
    setBusy(false);
  }
}

$("btn-download-csv").addEventListener("click", downloadCsv);

// ---------------------------------------------------------------- selector check tools (read-only)
async function runCheck(type, format) {
  try {
    const res = await page(type);
    show(res?.ok ? format(res) : `Failed: ${res?.error ?? "no response"}`);
  } catch {
    show("Content script not active. Reload the LinkedIn tab and try again.");
  }
}

$("btn-diagnose").addEventListener("click", () => runCheck(MSG.DIAGNOSE, (r) => r.report));
// Preview: what was extracted, what is missing, and whether mapping + the database keep it. Nothing is saved.
async function previewExtraction() {
  let r;
  try {
    r = await page(MSG.EXTRACT_PREVIEW);
  } catch {
    return show("Content script not active. Reload the LinkedIn tab and try again.");
  }
  if (!r?.ok) return show(`Failed: ${r?.error ?? "no response"}`);
  const schema = state.user ? await worker(MSG.SCHEMA_STATUS) : { ok: false };
  const detailColumns = schema.ok ? schema.detailColumns : true;
  const c = r.completeness || {};
  const d = c.detail || {};
  const ck = r.checks || {};
  const panelId = ck.aboutId || ck.titleLinkId || null;
  const idLine = `Selected job (URL): ${ck.pageUrlId || "none"} | panel job: ${panelId || "none"} | match: ${ck.pageUrlId && panelId ? (ck.pageUrlId === panelId ? "yes" : "NO") : "n/a"}`;
  const stage = r.detail ? "none (extracted)" : `detail panel - ${REASON_TEXT[r.detailReason] || r.detailReason}`;
  const lines = [
    idLine,
    `Description: ${ck.descriptionContainerFound ? `found, ${ck.descriptionChars || 0} characters` : "not found"} | failed stage: ${stage}`,
    `Open job: ${d.status === "failed" ? `not extracted (${r.detailReason})` : `${d.status} - ${(d.found || []).length} fields found`}`,
  ];
  if (r.detail) lines.push(`  Responsibilities: ${(r.detail.responsibilities || []).length} | qualifications: ${(r.detail.qualifications || []).length} | preferred: ${(r.detail.preferredQualifications || []).length} | experience: ${r.detail.experience ? "yes" : "no"} | skills: ${(r.detail.skills || []).length}`);
  if (d.missingCore?.length) lines.push(`  Missing (required for complete): ${d.missingCore.join(", ")}`);
  if (d.missingExpected?.length) lines.push(`  Missing (usually shown): ${d.missingExpected.join(", ")}`);
  if (d.notStatedOnPage?.length) lines.push(`  Not stated for this job: ${d.notStatedOnPage.join(", ")}`);
  if (d.selectorIssues?.length) lines.push(`  Selector matched but read nothing: ${d.selectorIssues.join(", ")}`);
  const cards = c.cards || {};
  lines.push(`Cards in the list: ${cards.count || 0} (card-only = partial; ${(cards.detailOnlyFields || []).length} fields exist only in the open job's details)`);
  const mapping = r.detail ? mappingReport(r.detail, { detailColumns }) : null;
  if (mapping) {
    lines.push(mapping.ok
      ? `Mapping: ${mapping.mapped.length} fields kept${mapping.dropped.length ? `; dropped: ${mapping.dropped.join(", ")}` : "; nothing dropped"}`
      : `Mapping: record would be rejected (${mapping.reason})`);
    if (mapping.needsMigration?.length) lines.push(`  Not stored until the database update (migration 20261022000200): ${mapping.needsMigration.join(", ")}`);
  }
  if (!schema.ok) lines.push("Database columns: not checked (no profile / offline).");
  show({
    summary: lines.join("\n"),
    layout: r.layout,
    detailReason: r.detailReason,
    identity: { selectedJobId: ck.pageUrlId || null, panelJobId: panelId, aboutSectionId: ck.aboutId || null, titleLinkId: ck.titleLinkId || null, candidatePanels: ck.candidatePanels || 1, rootSource: ck.rootSource || "lazy-column" },
    failedSelectors: r.failedSelectors,
    fieldSources: r.fieldSources,
    completeness: c,
    detail: r.detail,
    cardCount: r.cards.length,
    cards: r.cards.slice(0, 5),
  });
}
$("btn-extract").addEventListener("click", previewExtraction);

// ---------------------------------------------------------------- init
(async () => {
  await showPageStatus();
  await refreshAccount();
  await loadPrefs();
  await refreshWatch(); // reopening the popup shows the persisted session (watching, stopped, ...)
  const ping = await worker(MSG.PING);
  console.log("[LJS] service worker:", ping);
})();
