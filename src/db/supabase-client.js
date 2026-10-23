// Creates the single supabase-js client used by the service worker.
import { createClient } from "@supabase/supabase-js";
import { checkConfig } from "../shared/supabase-config.js";
import { DbError, ERR } from "./errors.js";
import { createChromeStorageAdapter } from "./storage-adapter.js";

export function createExtensionClient(config, storageArea) {
  const check = checkConfig(config);
  if (!check.ok) throw new DbError(ERR.NOT_CONFIGURED, check.reason);
  return createClient(config.url, config.publishableKey, {
    auth: {
      storage: createChromeStorageAdapter(storageArea),
      persistSession: true,
      autoRefreshToken: true, // timers stop with the worker; expired tokens are refreshed on the next call
      detectSessionInUrl: false, // no OAuth redirects in this extension
    },
  });
}
