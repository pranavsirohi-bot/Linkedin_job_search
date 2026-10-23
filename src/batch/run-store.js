// Persistence for the run checkpoint. The run lives in chrome.storage.local, so it survives the service worker
// sleeping, the extension reloading and the browser restarting. The popup/UI never owns this state.
//
//   ljs:run          the small checkpoint rewritten after every unit of work
//   ljs:run:payload  heavy, write-once inputs for the run (e.g. imported records), keyed by runId
export const RUN_KEY = "ljs:run";
export const PAYLOAD_KEY = "ljs:run:payload";

export function createChromeRunStore(area) {
  const store = area || (typeof chrome !== "undefined" ? chrome.storage.local : undefined);
  if (!store) throw new Error("chrome.storage is not available");
  return {
    async load() {
      const out = await store.get(RUN_KEY);
      return out[RUN_KEY] ?? null;
    },
    save: (state) => store.set({ [RUN_KEY]: state }),
    clear: () => store.remove(RUN_KEY),
    async loadPayload(runId) {
      const out = await store.get(PAYLOAD_KEY);
      const p = out[PAYLOAD_KEY];
      return p && p.runId === runId ? p.data : null;
    },
    savePayload: (runId, data) => store.set({ [PAYLOAD_KEY]: { runId, data } }),
    clearPayload: () => store.remove(PAYLOAD_KEY),
  };
}

// In-memory store with the same interface (tests, and a fallback for unit-testing the controller).
// `snapshot()` / `restore()` let a test simulate a service-worker or browser restart by handing the persisted data
// to a brand-new controller.
export function createMemoryRunStore(initial = {}) {
  let data = JSON.parse(JSON.stringify(initial));
  return {
    async load() { return data[RUN_KEY] ? JSON.parse(JSON.stringify(data[RUN_KEY])) : null; },
    async save(state) { data[RUN_KEY] = JSON.parse(JSON.stringify(state)); },
    async clear() { delete data[RUN_KEY]; },
    async loadPayload(runId) { const p = data[PAYLOAD_KEY]; return p && p.runId === runId ? JSON.parse(JSON.stringify(p.data)) : null; },
    async savePayload(runId, d) { data[PAYLOAD_KEY] = { runId, data: JSON.parse(JSON.stringify(d)) }; },
    async clearPayload() { delete data[PAYLOAD_KEY]; },
    snapshot: () => JSON.parse(JSON.stringify(data)),
  };
}
