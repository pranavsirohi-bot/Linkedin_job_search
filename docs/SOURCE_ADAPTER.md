# Adding an authorised job-data source

**No provider is configured, and none is assumed.** This document is the contract for adding one later, so that a new source is a small
adapter and not a rewrite. LinkedIn itself is never fetched, paged or clicked by any source.

## Before writing any code (requirements to report first)
1. **Permission:** you are allowed to use the provider's API for this purpose (read its terms; personal-use APIs are not for company use).
2. **Documented behaviour:** the search endpoint, how pagination works, the rate limits, the maximum page size, and the fields returned.
   If something is not documented, it is verified with a real test request before relying on it, never guessed.
3. **Credentials stay server-side:** the key lives as a secret in a backend you control (for example a Supabase Edge Function), which
   checks who is calling and rate-limits them. The extension only ever calls that backend. A key in extension code is public.
4. **Attribution:** whatever the provider requires (a label, a link back) is shown next to its jobs; the saved source id is the provider.
5. **Database:** jobs from another source need migrations `20261022000200` then `20261023000100` (see SUPABASE_SETUP.md). The run
   refuses to start until the database has them.

## The adapter
`createApiSource` in [`src/sources/api-source.js`](../src/sources/api-source.js) builds a complete run-controller source from:

| You write | Does |
|---|---|
| `parseParams(params, { maxJobs })` | Validates the user's filters and **whitelists** them (params are saved in the run checkpoint; keys and tokens must never be among them) |
| `fetchPage({ params, cursor, pageSize, signal })` | One bounded page through the server-side proxy. Returns `{ items, nextCursor, total?, warnings? }` and follows the **provider's documented** pagination |
| `idOf(raw)` | The provider's stable job id. With the source id it is the de-duplication key |
| `toRecord(raw, ref)` | Copies the fields the API returned into a job record. Missing fields stay empty; nothing is invented |
| `fetchDetails(...)` (optional) | Only for APIs whose list items are incomplete |
| `retryParams(params, failedIds)` (optional) | Enables "Retry failed records" |

Errors thrown by `fetchPage` decide what the controller does: `SourceError("rate-limited", msg, { retryAfterMs })` waits at least that
long, `"transient"` backs off exponentially (1 s, 2 s, 4 s, ...), `"fatal"` ends the run keeping what was saved, `"not-found"` skips the job.

## What the shared controller then provides
Sequential processing in small batches, Start / Pause / Resume / Stop (a save in progress always finishes), persistent checkpoints and
recovery after the popup closes or the browser restarts, one run at a time, repeated-cursor and empty-page protection, job and page
limits, duplicate detection, a confirmed save per batch, per-record results (new / updated / partial / skipped / failed), and
retry of failed records.

## Records and honesty
A record without a description or company is saved as **partial** with the reason; it is never filled in. The saved row carries
`provider` (the source id) and the provider's id; `source` is set by the adapter, not by provider code, so a provider cannot claim
to be LinkedIn.

## Registering it
Add the source to the list in `src/background/service-worker.js` (`registered`). A source with `automatic: true` makes the popup name it as an
available automatic source. Do that only once the requirements above are met.
