// The checks a batch run must pass before it starts (kept separate from the service worker so they can be tested).
//   1. Supabase is configured.
//   2. There is a usable (anonymous) session; this may create or recover one.
//   3. For any source other than the internal LinkedIn-page snapshot, the database can store jobs from other sources
//      (migration 20261023000100). Refused up front with a clear message instead of failing every save mid-run.
import { DbError, ERR } from "../db/errors.js";
import { RunError } from "../batch/run-state.js";

export const DB_UPDATE_MESSAGE =
  "Importing jobs needs a database update first (migrations 20261022000200 and 20261023000100, see docs/SUPABASE_SETUP.md). " +
  "They have not been applied, so nothing was imported.";

export function makeBatchPreflight({ checkConfig, ensureReady, providerColumnsReady, internalSourceId = "linkedin-page" }) {
  return async function preflight({ sourceId } = {}) {
    const cfg = checkConfig();
    if (!cfg.ok) throw new DbError(ERR.NOT_CONFIGURED, cfg.reason);
    await ensureReady();
    if (sourceId && sourceId !== internalSourceId && !(await providerColumnsReady())) {
      throw new RunError("database-update-required", DB_UPDATE_MESSAGE);
    }
  };
}
