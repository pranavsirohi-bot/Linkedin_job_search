// Template for a source backed by a DOCUMENTED, AUTHORISED, paginated job-data API.
//
// It turns three small functions that you write for one provider into a complete run-controller source, so the provider-specific part
// stays tiny and everything else (sequential processing, checkpoints, Pause / Resume / Stop, retries with backoff, rate-limit
// handling, de-duplication, incremental saves, counters, retry-failed) is the shared run controller.
//
// NOTHING IS REGISTERED FROM THIS FILE: no provider is configured and none is assumed. See docs/SOURCE_ADAPTER.md.
//
// Credentials: `fetchPage` / `fetchDetails` must call an authenticated SERVER-SIDE proxy (for example a Supabase Edge Function that
// holds the provider's key as a secret and checks the caller). They must never contain or send a provider key from extension code.
// An API key in extension JavaScript is readable by anyone who has the extension.
//
// Honesty: `toRecord` copies what the API returned and nothing else; a missing field stays empty and the record is graded partial.
import { safeHttpsUrl } from "../db/job-mapper.js";
import { SourceError } from "./http.js";

const ID_RE = /^[a-z][a-z0-9_-]{1,30}$/;
const FN = (v) => typeof v === "function";

// A record is complete only when the API gave a description and a company; otherwise it is stored as partial, with the reason.
export function gradeRecord(rec) {
  const missing = [!rec.description && "missing:description", !rec.company && "missing:company"].filter(Boolean);
  return { ...rec, extractionStatus: missing.length ? "partial" : "complete", extractionWarnings: missing };
}

/**
 * @param {object}   o
 * @param {string}   o.id            lowercase source id; also the `provider` stored with every job (source attribution)
 * @param {string}   o.label         shown in the UI
 * @param {Function} o.parseParams   (params, { maxJobs }) => { ok, params } | { ok:false, errors[] }. MUST whitelist: params are
 *                                   persisted in the run checkpoint, so anything not whitelisted (keys, tokens) is dropped here.
 * @param {Function} o.fetchPage     async ({ params, cursor, pageSize, signal }) => { items: raw[], nextCursor, total?, warnings? }
 *                                   One bounded page, via the server-side proxy. Throw SourceError("rate-limited", ..., { retryAfterMs }),
 *                                   ("transient"), ("fatal"), ("not-found") so the controller can back off or stop correctly.
 * @param {Function} o.idOf          (raw) => stable id of the job at the provider (the de-duplication key together with `id`)
 * @param {Function} o.toRecord      (raw, ref) => job record | null. Fields: title, url (https), company, location, description,
 *                                   postedDate (YYYY-MM-DD), salary, employmentType, workplaceType, skills[] ... only what the API gave.
 * @param {Function} [o.fetchDetails] async ({ ref, params, signal }) => raw. Only for APIs whose list items are not complete.
 *                                   Without it the list item itself is the job (re-read from its page if the worker restarted).
 * @param {Function} [o.retryParams] (params, failedIds) => params | null. Enables "Retry failed records".
 */
export function createApiSource({ id, label, parseParams, fetchPage, idOf, toRecord, fetchDetails, retryParams }) {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error("API source needs a valid id (lowercase letters, digits, - _)");
  if (id === "linkedin" || id === "linkedin-page") throw new Error("An API source cannot use a LinkedIn id");
  for (const [name, fn] of Object.entries({ parseParams, fetchPage, idOf, toRecord })) if (!FN(fn)) throw new Error(`API source "${id}" is missing ${name}()`);

  const cache = new Map(); // externalId -> raw list item, for the page(s) fetched in this worker's lifetime
  const remember = (items) => {
    for (const it of items) { cache.set(String(idOf(it)), it); }
    while (cache.size > 400) cache.delete(cache.keys().next().value);
  };

  return {
    id,
    label: String(label || id).slice(0, 80),
    automatic: true, // fetches and pages by itself from an authorised API
    heavyParams: [],
    validateParams(params, ctx = {}) {
      let r;
      try { r = parseParams(params && typeof params === "object" ? params : {}, ctx); } catch (e) { return { ok: false, errors: [String((e && e.message) || "Invalid settings.")] }; }
      if (!r || r.ok !== true) return { ok: false, errors: (r && r.errors) || ["Invalid settings."] };
      return { ok: true, params: r.params || {} };
    },
    describeCursor(cursor) {
      if (cursor && typeof cursor === "object" && Number.isInteger(cursor.page)) return `page ${cursor.page}`;
      try { return `next page (${JSON.stringify(cursor).slice(0, 60)})`; } catch { return "next page"; }
    },
    async search(params, cursor, { pageSize, signal }) {
      const page = await fetchPage({ params, cursor: cursor == null ? null : cursor, pageSize, signal });
      if (!page || typeof page !== "object" || !Array.isArray(page.items)) throw new SourceError("malformed", "The API returned an unexpected page");
      const items = page.items.slice(0, pageSize);
      remember(items);
      const refs = items.map((it) => ({ externalId: String(idOf(it) ?? ""), title: String((it && it.title) || (it && it.name) || "").slice(0, 120), c: cursor == null ? null : cursor, n: pageSize }));
      return { refs, nextCursor: page.nextCursor == null ? null : page.nextCursor, total: Number.isInteger(page.total) ? page.total : undefined, warnings: page.warnings };
    },
    async getDetails(ref, { params, signal }) {
      if (cache.has(ref.externalId)) return cache.get(ref.externalId);
      if (fetchDetails) return fetchDetails({ ref, params, signal });
      // The in-memory copy is gone (the worker slept or the browser restarted): read the page this reference came from again.
      const page = await fetchPage({ params, cursor: ref.c == null ? null : ref.c, pageSize: Number.isInteger(ref.n) ? ref.n : 25, signal });
      const items = page && Array.isArray(page.items) ? page.items : [];
      remember(items);
      return items.find((it) => String(idOf(it)) === ref.externalId) || null; // gone from the results: counted as skipped
    },
    normalize(raw, ref) {
      const rec = toRecord(raw, ref);
      if (!rec || typeof rec !== "object") return null;
      const url = safeHttpsUrl(String(rec.url || "").trim());
      if (!url) return null; // a job without a usable https link is malformed
      const { provider: _p, externalId: _e, source: _s, ...rest } = rec; // identity and attribution are set here, not by the provider code
      return gradeRecord({ ...rest, provider: id, externalId: String(idOf(raw)), url, source: "detail", collectedAt: rec.collectedAt || new Date().toISOString() });
    },
    ...(FN(retryParams) ? { retryParams } : {}),
  };
}
