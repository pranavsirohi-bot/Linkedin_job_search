// Batch import panel of the popup: process a CSV / JSON file of jobs automatically (Start / Pause / Resume / Stop),
// with progress, counters, the current job and the last error. It only sends commands to the service worker's run
// controller and displays the persisted run state, so closing the popup neither stops nor loses a run.
// The extension reads nothing from LinkedIn here: the jobs come from a file the user chose.
import { MSG } from "../shared/messages.js";
import { ACTIVE_STATUSES, STATUS, summarize } from "../batch/run-state.js";
import { RUN_KEY } from "../batch/run-store.js";
import { FILE_LIMITS, parseImportFile } from "../sources/file-import.js";
import { csvField } from "../export/csv.js";
import { downloadBlob } from "../export/download.js";

const SOURCE_ID = "file";
const DEFAULT_MAX = 200;
const HARD_MAX = FILE_LIMITS.maxRecordsHard; // 500
const MAX_PASTE_CHARS = FILE_LIMITS.maxBytes;
const RETRY_REASONS = new Set(["save-failed", "save-blocked", "too-many-failures"]);

const OUTCOME_LABEL = { new: "Saved (new)", updated: "Updated (already existed)", saved: "Saved", partial: "Saved (partial)", skipped: "Skipped", failed: "Failed" };

// One line per record: what happened to it and why. Text is escaped / formula-neutralised by csvField.
export function resultsCsv(results) {
  const lines = [["Record ID", "Title", "Outcome", "Reason"].map(csvField).join(",")];
  for (const r of results || []) lines.push([r.id, r.title, OUTCOME_LABEL[r.outcome] || r.outcome, r.reason].map(csvField).join(","));
  return "\uFEFF" + lines.join("\r\n") + "\r\n"; // UTF-8 BOM so Excel reads non-ASCII text; CRLF per RFC 4180
}

const REASON_TEXT = {
  "save-failed": "Paused: the jobs could not be saved (connection problem).",
  "save-blocked": "Paused: saving was blocked (session or configuration problem).",
  "too-many-failures": "Paused after repeated failures.",
  user: "Paused.",
};

export function initImportPanel({ $, worker, plural, canRun }) {
  const state = { run: null, file: null, busy: false, dbReady: null, sources: [], message: null, timer: null };
  const current = () => (state.run && state.run.sourceId === SOURCE_ID ? state.run : null);
  const isActive = (r) => !!r && ACTIVE_STATUSES.has(r.status);

  function say(text, kind = "") {
    state.message = text ? { text, kind } : null;
    render();
  }

  // ------------------------------------------------------------ rendering
  function runLine(run) {
    const c = run.counters;
    const tally = `${plural(c.saved, "new job")} saved, ${c.duplicates} already saved (updated), ${run.partial || 0} partial, ${c.skipped} skipped, ${c.failed} failed`;
    switch (run.status) {
      case STATUS.RUNNING: return { text: run.pauseRequested ? "Pausing: finishing the current batch..." : `${run.retryOf ? "Retrying failed records... " : "Importing... "}${c.processed} of ${run.total} processed.`, kind: "" };
      case STATUS.STOPPING: return { text: "Stopping: finishing the save already in progress, then nothing more is processed.", kind: "warn" };
      case STATUS.PAUSED: return { text: `${REASON_TEXT[run.pausedReason] || "Paused."} ${RETRY_REASONS.has(run.pausedReason) ? "Press Retry to try again" : "Press Resume to continue"} (nothing is duplicated), or Stop to end.`, kind: "warn" };
      case STATUS.INTERRUPTED: return { text: "Interrupted (the browser or extension restarted). Jobs saved so far are kept; press Resume to continue, or Stop to end.", kind: "warn" };
      case STATUS.STOPPED: return { text: `Stopped by you after ${c.processed} of ${run.total}: ${tally}. Jobs saved so far are kept.${run.failedCount ? ` ${plural(run.failedCount, "record")} failed: press "Retry failed" to process them again.` : ""}`, kind: "warn" };
      case STATUS.COMPLETED: return { text: `Completed: ${tally}.${run.moreAvailable ? " The maximum-records limit was reached; more records remain in the file." : ""}${run.failedCount ? ` Press "Retry failed" to process the ${plural(run.failedCount, "failed record")} again.` : ""}`, kind: run.failedCount ? "warn" : "ok" };
      case STATUS.FAILED: return { text: `Failed: ${run.lastError ? run.lastError.message : "unknown error"}. Jobs saved before the error are kept.`, kind: "error" };
      default: return { text: run.status, kind: "" };
    }
  }

  function render() {
    const run = current();
    const active = isActive(run);
    const running = !!run && run.status === STATUS.RUNNING;
    const resumable = !!run && (run.status === STATUS.PAUSED || run.status === STATUS.INTERRUPTED);
    const stoppable = !!run && (running || resumable || run.status === STATUS.STOPPING);
    const parsed = state.file && state.file.parsed;
    const ready = !!parsed && parsed.ok && parsed.records.length > 0;

    $("import-section").hidden = !canRun();
    $("import-start").disabled = state.busy || active || !ready;
    $("import-pause").disabled = state.busy || !running || run.pauseRequested;
    $("import-resume").disabled = state.busy || !resumable;
    $("import-resume").textContent = resumable && RETRY_REASONS.has(run.pausedReason) ? "Retry" : "Resume";
    $("import-stop").disabled = state.busy || !stoppable || run.status === STATUS.STOPPING;
    $("import-dismiss").hidden = !run || active;
    const finished = !!run && !active;
    $("import-retry").hidden = !(finished && run.failedCount > 0);
    $("import-retry").textContent = `Retry failed (${run ? run.failedCount : 0})`;
    $("import-retry").disabled = state.busy;
    $("import-results").hidden = !(run && run.results && run.results.length > 0);
    for (const id of ["import-file", "import-max", "import-paste-btn", "import-paste"]) $(id).disabled = active;

    // Source selector: the registered batch sources (the LinkedIn page snapshot is internal and not offered).
    const sel = $("import-source");
    const offered = state.sources.filter((s) => s.id === SOURCE_ID);
    if (sel.options.length !== offered.length || (offered[0] && sel.options[0] && sel.options[0].value !== offered[0].id)) {
      sel.textContent = "";
      for (const s of offered) { const o = document.createElement("option"); o.value = s.id; o.textContent = s.label; sel.append(o); }
    }
    sel.disabled = true; // a single permitted source today; the selector is the integration point for an authorised API

    $("import-db-note").hidden = state.dbReady !== false;

    const c = run ? run.counters : { discovered: 0, processed: 0, saved: 0, duplicates: 0, skipped: 0, failed: 0 };
    const total = run ? run.total : ready ? parsed.records.length : 0;
    $("ik-total").textContent = String(total);
    $("ik-processed").textContent = String(c.processed);
    $("ik-saved").textContent = String(c.saved);
    $("ik-duplicates").textContent = String(c.duplicates);
    $("ik-partial").textContent = String(run ? run.partial || 0 : 0);
    $("ik-skipped").textContent = String(c.skipped);
    $("ik-failed").textContent = String(c.failed);
    const pct = !run ? 0 : run.status === STATUS.COMPLETED ? 100 : Math.min(100, Math.round((100 * c.processed) / Math.max(total, 1)));
    $("import-fill").style.width = `${pct}%`;
    $("import-bar").setAttribute("aria-valuenow", String(pct));

    let line;
    if (state.message) line = state.message;
    else if (run) line = runLine(run);
    else line = { text: ready ? `Ready: ${plural(parsed.records.length, "job")} from ${state.file.name}. Press Start import.` : "Choose a CSV or JSON file of jobs.", kind: "" };
    $("import-status").textContent = line.text;
    $("import-status").className = `run-status${line.kind ? ` ${line.kind}` : ""}`;

    // Current job and source.
    const label = (state.sources.find((s) => s.id === SOURCE_ID) || {}).label || "Imported file";
    const now = run && run.status === STATUS.RUNNING && run.current ? run.current.title || run.current.externalId : "";
    $("import-current").hidden = !now;
    $("import-current").textContent = now ? `Now: ${now} (source: ${label})` : "";

    // Last error and the most recent failed records.
    const err = run && run.lastError && (active || run.status === STATUS.FAILED) ? run.lastError.message : "";
    $("import-error").hidden = !err;
    $("import-error").textContent = err ? `Last problem: ${err}` : "";
    const fails = run ? run.failures || [] : [];
    $("import-failures").hidden = !fails.length;
    const ul = $("import-failure-items");
    ul.textContent = "";
    for (const f of fails) { const li = document.createElement("li"); li.textContent = `${f.externalId}: ${f.reason}`; ul.append(li); }
  }

  function renderFileSummary() {
    const box = $("import-summary");
    box.textContent = "";
    const f = state.file;
    box.hidden = !f;
    if (!f) return;
    const p = f.parsed;
    if (!p.ok) { box.append(p.error); return; }
    const lines = [`${plural(p.records.length, "valid job")} ready to import from ${f.name}.`];
    if (p.rejectedCount) lines.push(`${plural(p.rejectedCount, "record")} rejected (not imported).`);
    if (p.duplicates) lines.push(`${plural(p.duplicates, "duplicate")} inside the file ignored.`);
    if (p.overLimit) lines.push(`${plural(p.overLimit, "record")} beyond the maximum-records limit will not be imported.`);
    box.append(lines.join(" "));
    if (p.rejected.length) {
      const ul = document.createElement("ul");
      for (const r of p.rejected.slice(0, 5)) { const li = document.createElement("li"); li.textContent = `Row ${r.row}: ${r.reason}`; ul.append(li); }
      box.append(ul);
    }
  }

  // ------------------------------------------------------------ file / pasted text (validated here AND again in the worker)
  const maxRecords = () => Math.min(Math.max(Math.floor(Number($("import-max").value)) || DEFAULT_MAX, 1), HARD_MAX);
  function parseNow() {
    const f = state.file;
    if (!f || f.text == null) return;
    f.parsed = parseImportFile({ name: f.name, size: f.size, text: f.text }, { maxRecords: maxRecords() });
    renderFileSummary();
  }
  async function onFile() {
    const file = $("import-file").files && $("import-file").files[0];
    state.file = null;
    state.message = null;
    if (file) {
      if (!/\.(csv|json)$/i.test(file.name)) state.file = { name: file.name, size: file.size, text: null, parsed: { ok: false, error: "Only .csv and .json files can be imported." } };
      else if (file.size > FILE_LIMITS.maxBytes) state.file = { name: file.name, size: file.size, text: null, parsed: { ok: false, error: "The file is larger than 2 MB." } };
      else {
        let text = null;
        try { text = await file.text(); } catch { /* reported below */ }
        state.file = { name: file.name, size: file.size, text, parsed: null };
        if (text == null) state.file.parsed = { ok: false, error: "The file could not be read." };
        else parseNow();
      }
    }
    renderFileSummary();
    render();
  }
  // Some systems close an extension popup when the native file dialog opens: pasting is the fallback.
  function onPaste() {
    const text = String($("import-paste").value || "");
    state.message = null;
    if (!text.trim()) state.file = { name: "pasted text", size: 0, text: null, parsed: { ok: false, error: "Paste CSV or JSON first." } };
    else if (text.length > MAX_PASTE_CHARS) state.file = { name: "pasted text", size: text.length, text: null, parsed: { ok: false, error: "The pasted text is larger than 2 MB." } };
    else {
      const t = text.trim();
      state.file = { name: t.startsWith("[") || t.startsWith("{") ? "pasted.json" : "pasted.csv", size: text.length, text, parsed: null };
      parseNow();
    }
    renderFileSummary();
    render();
  }

  // ------------------------------------------------------------ commands
  async function command(type, payload = {}) {
    if (state.busy) return null;
    state.busy = true;
    render();
    const res = await worker(type, payload);
    state.busy = false;
    if (!res.ok) { say(res.error.message, res.error.code === "stale-run" ? "warn" : "error"); return res; }
    state.message = null;
    if (Array.isArray(res.sources)) state.sources = res.sources;
    state.run = res.run;
    render();
    return res;
  }

  async function start() {
    const p = state.file && state.file.parsed;
    if (!p || !p.ok || !p.records.length) return say("Choose a file with at least one valid job first.", "warn");
    if (!navigator.onLine) return say("You're offline. Nothing was imported; try again when you're connected.", "error");
    const n = Math.min(p.records.length, maxRecords());
    state.run = null; // a new run replaces the previous result on screen
    await command(MSG.RUN_START, {
      sourceId: SOURCE_ID,
      params: { records: p.records, fileName: state.file.name, stats: { total: p.total, valid: p.records.length, invalid: p.rejectedCount, duplicatesInFile: p.duplicates, overLimit: p.overLimit } },
      limits: { maxJobs: n, maxPages: Math.ceil(n / 50) + 1, pageSize: 50 },
    });
  }

  async function refresh({ schema = true } = {}) {
    const res = await worker(MSG.RUN_STATUS);
    if (res.ok) { state.run = res.run; if (Array.isArray(res.sources)) state.sources = res.sources; }
    if (schema && canRun()) { // the database level is asked once per popup, not on every progress poll
      const level = await worker(MSG.SCHEMA_STATUS);
      if (level.ok) state.dbReady = !!level.multiProvider;
    }
    render();
  }

  $("import-file").addEventListener("change", onFile);
  $("import-paste-btn").addEventListener("click", onPaste);
  $("import-max").addEventListener("input", () => { if (state.file && state.file.text != null) { parseNow(); render(); } });
  $("import-start").addEventListener("click", start);
  $("import-pause").addEventListener("click", () => command(MSG.RUN_PAUSE));
  $("import-resume").addEventListener("click", () => command(MSG.RUN_RESUME));
  $("import-stop").addEventListener("click", () => { const r = current(); if (r) command(MSG.RUN_STOP, { runId: r.runId }); });
  $("import-retry").addEventListener("click", () => command(MSG.RUN_RETRY_FAILED));
  $("import-results").addEventListener("click", () => {
    const r = current();
    if (!r || !r.results || !r.results.length) return;
    downloadBlob(new Blob([resultsCsv(r.results)], { type: "text/csv;charset=utf-8" }), `import-results-${new Date().toISOString().slice(0, 10)}.csv`);
  });
  $("import-dismiss").addEventListener("click", () => { const r = current(); if (r) command(MSG.RUN_DISMISS, { runId: r.runId }); });

  // Live progress: the worker writes its checkpoint to chrome.storage.local after every batch.
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && RUN_KEY in changes) { state.run = summarize(changes[RUN_KEY].newValue); render(); }
    });
  }
  state.timer = setInterval(() => { if (isActive(current())) refresh({ schema: false }); }, 1500); // fallback
  window.addEventListener("pagehide", () => clearInterval(state.timer));

  return { render, refresh };
}
