import { createRunController } from "../batch/run-controller.js";
import { createChromeRunStore } from "../batch/run-store.js";
import { createExtensionClient } from "../db/supabase-client.js";
import { ensureSession } from "../db/auth.js";
import { providerColumnsAvailable, saveJobs, savedDetailStatus } from "../db/saved-jobs.js";
import { createFileSource } from "../sources/file-import.js";
import { createLinkedInPageSource } from "../sources/linkedin-page.js";
import { MSG } from "../shared/messages.js";
import { SUPABASE_CONFIG, checkConfig } from "../shared/supabase-config.js";
import { createChromeWatchStore, createWatchSession } from "../watch/watch-session.js";
import { createHandlers, createSessionRunner } from "./handlers.js";
import { makeBatchPreflight } from "./preflight.js";
import { makeIsLinkedInContentSender, makeIsTrustedSender } from "./trust.js";

let client = null;
const getClient = () => (client ??= createExtensionClient(SUPABASE_CONFIG));

// Only this extension's own pages (popup, saved-jobs page) may use database/run messages. Content scripts run inside
// linkedin.com pages, so their sender.url is not on the extension's origin and they are rejected. Our content script
// may send exactly one data-free message: PAGE_CHANGED.
const isTrustedSender = makeIsTrustedSender(chrome.runtime.id);
const isContentSender = makeIsLinkedInContentSender(chrome.runtime.id);
const withSession = createSessionRunner(getClient);
const save = (jobs) => withSession((c) => saveJobs(c, jobs)); // same idempotent, merge-safe path as "Save open job only"

// Batch sources the run controller can drive:
//   linkedin-page  kept for runs started by version 0.6.1 (a one-page snapshot); the popup uses auto-save instead
//   file           records from a CSV / JSON file the user chose (a permitted import). Processed automatically, one batch at a time.
// Sources that fetch jobs by themselves from the web ("automatic") would be listed here once an AUTHORISED data source is
// configured (see docs/SUPABASE_SETUP.md, "Automatic pagination / other sources"). None is; LinkedIn is never fetched.
const linkedInPage = createLinkedInPageSource();
const fileImport = createFileSource();
const registered = [linkedInPage, fileImport];
const sources = {
  get: (id) => registered.find((s) => s.id === id) || null,
  list: () => registered.map((s) => ({ id: s.id, label: s.label, automatic: s.automatic === true })),
};
const runs = createRunController({
  store: createChromeRunStore(),
  sources,
  save,
  preflight: makeBatchPreflight({
    checkConfig: () => checkConfig(SUPABASE_CONFIG),
    ensureReady: () => ensureSession(getClient()),
    providerColumnsReady: () => withSession((c) => providerColumnsAvailable(c)),
    internalSourceId: linkedInPage.id,
  }),
});

// Auto-save while the user browses. The worker reads the watched tab through our content script (read-only), only
// after the page changed. Only in auto-click mode (opt-in per session) does the content script open jobs and page on.
const isLinkedInUrl = (url) => { try { const u = new URL(url); return u.protocol === "https:" && u.hostname === "www.linkedin.com"; } catch { return false; } };
const watch = createWatchSession({
  store: createChromeWatchStore(),
  save,
  lookup: (ids) => withSession((c) => savedDetailStatus(c, ids)), // read-only: which listed jobs are already saved in full
  checkTab: async (tabId) => { try { return isLinkedInUrl((await chrome.tabs.get(tabId)).url); } catch { return false; } },
  pullSnapshot: async (tabId) => {
    const tab = await chrome.tabs.get(tabId);
    if (!isLinkedInUrl(tab.url)) return { ok: false }; // the user left LinkedIn in that tab: nothing to read
    return chrome.tabs.sendMessage(tabId, { type: MSG.EXTRACT_PREVIEW, waitForDetailMs: 4000 }, { frameId: 0 });
  },
});
chrome.tabs.onRemoved.addListener((tabId) => { watch.tabClosed(tabId).catch(() => {}); });

const ready = Promise.all([runs.recover("sw-wake").catch(() => {}), watch.recover("sw-wake").catch(() => {})]);
chrome.runtime.onInstalled.addListener((details) => {
  console.log("[LJS] installed/updated:", details.reason);
  runs.recover("extension-reload").catch(() => {});
  watch.recover("extension-reload").catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  runs.recover("browser-start").catch(() => {});
  watch.recover("browser-start").catch(() => {});
});

const handle = createHandlers({
  getClient,
  checkConfig: () => checkConfig(SUPABASE_CONFIG),
  isTrustedSender,
  isContentSender,
  runs,
  sources,
  watch,
  withSession,
  ready,
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!handle.handles(message && message.type)) return false; // not ours; don't hold the channel open
  handle(message, sender).then(sendResponse);
  return true; // keep the channel open for the async response
});
