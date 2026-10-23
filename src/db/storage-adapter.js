// supabase-js session storage backed by chrome.storage.local. Service workers have no localStorage, and the
// session must survive the worker being stopped. Tokens are readable only by this extension's own pages,
// but are stored unencrypted on disk by Chrome. Use chrome.storage.session instead to forget on browser close.
export function createChromeStorageAdapter(area, prefix = "ljs-auth:") {
  const store = area || (typeof chrome !== "undefined" ? chrome.storage.local : undefined);
  if (!store) throw new Error("chrome.storage is not available");
  return {
    async getItem(key) {
      const k = prefix + key;
      const out = await store.get(k);
      return out[k] ?? null;
    },
    async setItem(key, value) {
      await store.set({ [prefix + key]: value });
    },
    async removeItem(key) {
      await store.remove(prefix + key);
    },
  };
}
