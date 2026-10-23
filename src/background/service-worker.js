import { createRunController } from "../batch/run-controller.js";
import { createChromeRunStore } from "../batch/run-store.js";
import { createExtensionClient } from "../db/supabase-client.js";
import { ensureSession } from "../db/auth.js";
import { DbError, ERR } from "../db/errors.js";
import { saveJobs, savedDetailStatus } from "../db/saved-jobs.js";
import { createLinkedInPageSource } from "../sources/linkedin-page.js";
import { MSG } from "../shared/messages.js";
import { SUPABASE_CONFIG, checkConfig } from "../shared/supabase-config.js";
import { createChromeWatchStore, createWatchSession } from "../watch/watch-session.js";
import { createHandlers, createSessionRunner } from "./handlers.js";
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

// Kept for runs started by version 0.6.1 (a one-page snapshot); the popup now uses auto-save below.
const linkedInPage = createLinkedInPageSource();
// Sources that can fetch and page jobs by themselves ("automatic") would be listed here once an AUTHORISED data source is
// configured (see docs/SUPABASE_SETUP.md, "Automatic pagination / other sources"). None is.
const sources = {
  get: (id) => (id === linkedInPage.id ? linkedInPage : null),
  list: () => [{ id: linkedInPage.id, label: linkedInPage.label, automatic: linkedInPage.automatic === true }],
};
const runs = createRunController({
  store: createChromeRunStore(),
  sources,
  save,
  preflight: async () => {
    const cfg = checkConfig(SUPABASE_CONFIG);
    if (!cfg.ok) throw new DbError(ERR.NOT_CONFIGURED, cfg.reason);
    await ensureSession(getClient());
  },
});

// Auto-save while the user browses. The worker reads the watched tab through our content script (read-only), only
// after the user changed the page themselves. Nothing is clicked, scrolled, opened or navigated.
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
