// Batch collection UI, shared by the extension popup (main entry point) and the optional full-tab page.
// It is only a remote control and a viewer: the run itself lives in the service worker and its checkpoint in
// chrome.storage.local. Closing the popup, the page or the browser does not stop or lose anything; reopening shows
// the persisted state. Every element is looked up by id; optional elements (paste box, library button, open-in-tab
// link) are wired only when present.
import { ACTIVE_STATUSES, HARD_LIMITS, STATUS, TERMINAL_STATUSES, summarize } from "../batch/run-state.js";
import { RUN_KEY } from "../batch/run-store.js";
import { FILE_LIMITS, parseImportFile } from "../sources/file-import.js";
import { MSG } from "../shared/messages.js";

export const FORM_KEY = "ljs:batch-form"; // non-sensitive form draft (source, boards, limits) so a closed popup forgets nothing
const DEFAULT_MAX = 200;
const MAX_PASTE_CHARS = FILE_LIMITS.maxBytes;

const PAUSE_REASONS = {
  user: "Paused.",
  "too-many-failures": "Paused automatically after repeated failures.",
  "source-unreachable": "Paused: the job source could not be reached.",
  "save-failed": "Paused: the jobs could not be saved to Supabase (connection problem).",
  "save-blocked": "Paused: saving was blocked (session or configuration problem).",
};
const END_REASONS = {
  "no-more-results": "All available jobs were processed.",
  "job-limit": "Stopped at the maximum number of jobs.",
  "page-limit": "Stopped at the maximum number of pages.",
  "too-many-empty-pages": "Stopped: the source returned too many empty pages in a row.",
  stopped: "Stopped by you. Jobs saved so far are kept.",
  "repeated-cursor": "Stopped: the source repeated a page cursor, so paging was halted to avoid a loop.",
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function statusText(run) {
  if (!run) return "No run yet. Choose a source and press Start.";
  switch (run.status) {
    case STATUS.RUNNING: return run.pauseRequested ? "Pausing after the current step..." : "Running...";
    case STATUS.PAUSED: return PAUSE_REASONS[run.pausedReason] || "Paused.";
    case STATUS.STOPPING: return "Stopping...";
    case STATUS.INTERRUPTED: return "Interrupted (the browser or extension restarted). Your progress is saved; press Resume to continue.";
    case STATUS.COMPLETED:
      if (run.moreAvailable) {
        const which = run.endReason === "page-limit" ? "page" : "job";
        return `Limit reached: stopped at the maximum number of ${which}s. The source still has more jobs that were NOT collected; raise the limits or start another run to continue.`;
      }
      return `Completed. ${END_REASONS[run.endReason] || ""}`.trim();
    case STATUS.STOPPED: return END_REASONS.stopped;
    case STATUS.FAILED: return `Failed. ${END_REASONS[run.endReason] || ""} ${run.lastError ? run.lastError.message : ""}`.trim();
    default: return run.status;
  }
}

export function initBatchUI() {
  const $ = (id) => document.getElementById(id);
  const on = (id, event, fn) => { const el = $(id); if (el) el.addEventListener(event, fn); };
  const state = { run: null, busy: false, file: null /* { name, size, text, parsed } */ };
  const store = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local ? chrome.storage.local : null;

  async function worker(type, payload = {}) {
    try {
      return (await chrome.runtime.sendMessage({ type, ...payload })) ?? { ok: false, error: { code: "UNKNOWN", message: "No response from the extension. Try again." } };
    } catch {
      return { ok: false, error: { code: "UNKNOWN", message: "Could not reach the extension background. Reload the extension and try again." } };
    }
  }

  function message(text, kind = "info") {
    const el = $("message");
    el.hidden = !text;
    el.className = kind === "info" ? "" : kind;
    el.textContent = text || "";
  }

  // -------------------------------------------------------------- rendering
  function renderRetry() {
    const run = state.run;
    const line = $("retry-line");
    let text = "";
    if (run && run.status === STATUS.RUNNING) {
      if (run.waiting) text = `Waiting for the source's rate limit; continuing automatically at ${new Date(run.waiting.until).toLocaleTimeString()}.`;
      else if (run.retry) {
        const secs = Math.max(0, Math.ceil((run.retry.until - Date.now()) / 1000));
        text = `Retry ${run.retry.attempt} of ${HARD_LIMITS.maxRetries}${secs ? ` in ${secs}s` : " now"}: ${run.retry.reason}`;
      }
    }
    line.hidden = !text;
    line.textContent = text;
  }

  function render() {
    const run = state.run;
    const active = !!run && ACTIVE_STATUSES.has(run.status);
    const terminal = !!run && TERMINAL_STATUSES.has(run.status);
    const fileMode = $("source").value === "file";
    const fileReady = !!(state.file && state.file.parsed && state.file.parsed.ok && state.file.parsed.records.length);

    $("cfg-greenhouse").hidden = fileMode;
    $("cfg-file").hidden = !fileMode;
    for (const id of ["source", "boards", "keyword", "file", "paste-text", "btn-paste", "max-jobs", "max-pages", "page-size"]) {
      if ($(id)) $(id).disabled = active || state.busy;
    }

    $("btn-start").disabled = state.busy || active || (fileMode && !fileReady);
    $("btn-pause").disabled = state.busy || !(run && run.status === STATUS.RUNNING && !run.pauseRequested);
    $("btn-resume").disabled = state.busy || !(run && (run.status === STATUS.PAUSED || run.status === STATUS.INTERRUPTED || (run.status === STATUS.RUNNING && run.pauseRequested)));
    $("btn-stop").disabled = state.busy || !(run && (run.status === STATUS.RUNNING || run.status === STATUS.PAUSED || run.status === STATUS.INTERRUPTED));
    $("btn-dismiss").disabled = state.busy || !terminal;
    $("btn-dismiss").hidden = !terminal;

    const c = run ? run.counters : { discovered: 0, processed: 0, saved: 0, duplicates: 0, skipped: 0, failed: 0 };
    for (const k of Object.keys(c)) $(`c-${k}`).textContent = String(c[k]);

    $("run-status").textContent = statusText(run);
    const pct = !run ? 0 : run.status === STATUS.COMPLETED ? 100 : Math.min(100, Math.round((100 * c.processed) / Math.max(c.discovered, 1)));
    $("bar-fill").style.width = `${pct}%`;
    $("bar").setAttribute("aria-valuenow", String(pct));
    $("page-line").textContent = run
      ? `Pages fetched: ${run.page} of at most ${run.config.maxPages} | next: ${run.position || "-"} | up to ${plural(run.config.maxJobs, "job")} | ${plural(run.pendingCount, "job")} queued`
      : "";
    const st = run && run.sourceId === "file" ? run.importStats : null;
    $("import-line").hidden = !st;
    $("import-line").textContent = st
      ? `File: ${st.total} rows | ${st.valid} valid | ${st.invalid} invalid | ${st.duplicatesInFile} duplicate in file | ${c.saved} imported (new) | ${c.duplicates} already saved | ${c.failed} failed${st.overLimit ? ` | ${st.overLimit} over the limit` : ""}`
      : "";

    const err = run && run.lastError && run.status !== STATUS.COMPLETED && run.status !== STATUS.STOPPED ? run.lastError.message : "";
    $("error-line").hidden = !err;
    $("error-line").textContent = err ? `Last problem: ${err}` : "";
    renderRetry();

    const warnings = $("warnings");
    warnings.textContent = "";
    for (const w of run ? run.warnings : []) { const li = document.createElement("li"); li.textContent = w; warnings.append(li); }
    const failures = $("failures");
    failures.textContent = "";
    for (const f of run ? run.failures : []) { const li = document.createElement("li"); li.textContent = `${f.externalId}: ${f.reason}`; failures.append(li); }
    $("failures-box").hidden = !(run && run.failures.length);
  }

  // -------------------------------------------------------------- form draft (survives the popup closing)
  const FORM_FIELDS = { source: "source", boards: "boards", keyword: "keyword", maxJobs: "max-jobs", maxPages: "max-pages", pageSize: "page-size" };
  async function saveDraft() {
    if (!store) return;
    const draft = {};
    for (const [k, id] of Object.entries(FORM_FIELDS)) draft[k] = String($(id).value).slice(0, 2000);
    try { await store.set({ [FORM_KEY]: draft }); } catch { /* not critical */ }
  }
  async function restoreDraft() {
    if (!store) return;
    let draft;
    try { draft = (await store.get(FORM_KEY))[FORM_KEY]; } catch { return; }
    if (!draft || typeof draft !== "object") return;
    for (const [k, id] of Object.entries(FORM_FIELDS)) {
      if (typeof draft[k] !== "string") continue;
      if (id === "source" && !["greenhouse", "file"].includes(draft[k])) continue;
      $(id).value = draft[k];
    }
  }
  for (const id of Object.values(FORM_FIELDS)) on(id, "change", saveDraft);
  on("boards", "input", saveDraft);
  on("keyword", "input", saveDraft);

  // -------------------------------------------------------------- commands
  async function command(type, payload, { onOk } = {}) {
    if (state.busy) return;
    state.busy = true;
    render();
    const res = await worker(type, payload);
    state.busy = false;
    if (!res.ok) message(res.error.message, "error");
    else {
      state.run = res.run;
      message(onOk || "", onOk ? "ok" : "info");
    }
    render();
  }

  function limitsFromForm() {
    const limits = {};
    for (const [id, key] of [["max-jobs", "maxJobs"], ["max-pages", "maxPages"], ["page-size", "pageSize"]]) {
      const raw = $(id).value.trim();
      if (raw !== "") limits[key] = Number(raw);
    }
    return limits;
  }

  function paramsFromForm() {
    if ($("source").value === "file") {
      const p = state.file.parsed;
      return { records: p.records, fileName: state.file.name, stats: { total: p.total, valid: p.records.length, invalid: p.rejectedCount, duplicatesInFile: p.duplicates, overLimit: p.overLimit } };
    }
    return { boards: $("boards").value.split(/[\s,;]+/).filter(Boolean), keyword: $("keyword").value.trim() };
  }

  on("btn-start", "click", () => {
    if ($("source").value === "file" && !(state.file && state.file.parsed && state.file.parsed.ok)) return message("Choose a file with at least one valid job first.", "warn");
    command(MSG.RUN_START, { sourceId: $("source").value, params: paramsFromForm(), limits: limitsFromForm() }, { onOk: "Run started." });
  });
  on("btn-pause", "click", () => command(MSG.RUN_PAUSE));
  on("btn-resume", "click", () => command(MSG.RUN_RESUME));
  on("btn-stop", "click", () => command(MSG.RUN_STOP));
  on("btn-dismiss", "click", () => command(MSG.RUN_DISMISS));
  on("btn-library", "click", () => chrome.tabs.create({ url: chrome.runtime.getURL("src/library/library.html") }));
  on("btn-batch-tab", "click", () => chrome.tabs.create({ url: chrome.runtime.getURL("src/batchpage/batch.html") }));
  on("source", "change", () => { message(""); render(); });

  // -------------------------------------------------------------- file import preview (validated here AND in the worker)
  function renderFileSummary() {
    const box = $("file-summary");
    box.textContent = "";
    const f = state.file;
    box.hidden = !f;
    if (!f) return;
    const p = f.parsed;
    if (!p.ok) { box.append(p.error); return; }
    const lines = [`${plural(p.records.length, "valid job")} ready to import from ${f.name}.`];
    if (p.rejectedCount) lines.push(`${plural(p.rejectedCount, "record")} rejected (listed below, not imported).`);
    if (p.duplicates) lines.push(`${plural(p.duplicates, "duplicate")} inside the file ignored.`);
    if (p.overLimit) lines.push(`${plural(p.overLimit, "record")} beyond the maximum-jobs limit will not be imported.`);
    box.append(lines.join(" "));
    if (p.rejected.length) {
      const ul = document.createElement("ul");
      for (const r of p.rejected.slice(0, 10)) { const li = document.createElement("li"); li.textContent = `Row ${r.row}: ${r.reason}`; ul.append(li); }
      box.append(ul);
    }
  }

  function reparse() {
    const f = state.file;
    if (!f || !f.text) return;
    const maxRecords = Math.min(Math.max(Number($("max-jobs").value) || DEFAULT_MAX, 1), HARD_LIMITS.maxJobs);
    f.parsed = parseImportFile({ name: f.name, size: f.size, text: f.text }, { maxRecords });
    renderFileSummary();
  }

  on("file", "change", async () => {
    const input = $("file");
    const file = input.files && input.files[0];
    state.file = null;
    message("");
    if (file) {
      if (!/\.(csv|json)$/i.test(file.name)) state.file = { name: file.name, size: file.size, text: "", parsed: { ok: false, error: "Only .csv and .json files can be imported." } };
      else if (file.size > FILE_LIMITS.maxBytes) state.file = { name: file.name, size: file.size, text: "", parsed: { ok: false, error: "The file is larger than 2 MB." } };
      else {
        let text;
        try { text = await file.text(); } catch { text = null; }
        state.file = { name: file.name, size: file.size, text: text || "", parsed: null };
        if (text == null) state.file.parsed = { ok: false, error: "The file could not be read." };
        else reparse();
      }
    }
    renderFileSummary();
    render();
  });

  // Paste fallback: some systems close an extension popup when the native file dialog opens.
  on("btn-paste", "click", () => {
    const text = String($("paste-text").value || "");
    message("");
    if (!text.trim()) state.file = { name: "pasted text", size: 0, text: "", parsed: { ok: false, error: "Paste CSV or JSON first." } };
    else if (text.length > MAX_PASTE_CHARS) state.file = { name: "pasted text", size: text.length, text: "", parsed: { ok: false, error: "The pasted text is larger than 2 MB." } };
    else {
      const trimmed = text.trim();
      const name = trimmed.startsWith("[") || trimmed.startsWith("{") ? "pasted.json" : "pasted.csv";
      state.file = { name, size: text.length, text, parsed: null };
      reparse();
    }
    renderFileSummary();
    render();
  });
  on("max-jobs", "change", () => { reparse(); render(); });

  // -------------------------------------------------------------- live state (read from the persisted checkpoint)
  async function refresh() {
    if (state.busy) return;
    const res = await worker(MSG.RUN_STATUS);
    if (res.ok) { state.run = res.run; render(); }
  }

  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && RUN_KEY in changes) {
        state.run = summarize(changes[RUN_KEY].newValue);
        render();
      }
    });
  }
  const poll = setInterval(refresh, 2000); // fallback in case a storage event is missed
  const tickTimer = setInterval(renderRetry, 1000); // retry countdown
  const destroy = () => { clearInterval(poll); clearInterval(tickTimer); };
  window.addEventListener("pagehide", destroy);

  render();
  const ready = restoreDraft().then(() => { render(); return refresh(); });
  return { refresh, destroy, ready };
}
