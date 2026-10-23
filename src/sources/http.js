// Small, careful HTTP client for source adapters. GET + JSON only; classifies failures so the run controller can
// decide what to retry. It never sends credentials or cookies and never follows redirects to other hosts.

// kind: "rate-limited" (honour retryAfterMs) | "transient" (retry with backoff) | "not-found" | "fatal" | "malformed" | "aborted"
export class SourceError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "SourceError";
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
const MAX_BODY_CHARS = 8 * 1024 * 1024;

// Retry-After is either delay-seconds or an HTTP date. Returns milliseconds, or null when absent/invalid.
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === "") return null;
  const v = String(value).trim();
  let ms;
  if (/^\d+$/.test(v)) ms = Number(v) * 1000;
  else {
    const t = Date.parse(v);
    if (Number.isNaN(t)) return null;
    ms = t - now;
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

export async function fetchJson(url, { signal, timeoutMs = 20000, fetchImpl, headers } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") throw new SourceError("fatal", "fetch is not available in this context");
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); throw new SourceError("aborted", "Request cancelled"); }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    let res;
    try {
      res = await doFetch(url, { method: "GET", headers: { Accept: "application/json", ...headers }, credentials: "omit", redirect: "error", cache: "no-store", signal: ac.signal });
    } catch (e) {
      if (signal && signal.aborted) throw new SourceError("aborted", "Request cancelled");
      if (timedOut) throw new SourceError("transient", "The request timed out", { code: "timeout" });
      throw new SourceError("transient", "Network error while contacting the job source", { cause: e });
    }

    const retryAfterMs = parseRetryAfter(res.headers && res.headers.get && res.headers.get("retry-after"));
    if (res.status === 429) throw new SourceError("rate-limited", "The job source is rate limiting requests", { status: 429, retryAfterMs });
    if (res.status === 503 && retryAfterMs != null) throw new SourceError("rate-limited", "The job source asked us to wait", { status: 503, retryAfterMs });
    if (res.status === 404) throw new SourceError("not-found", "Not found", { status: 404 });
    if (res.status === 408 || res.status === 425 || res.status >= 500) throw new SourceError("transient", `The job source had a temporary problem (HTTP ${res.status})`, { status: res.status, retryAfterMs });
    if (res.status === 401 || res.status === 403) throw new SourceError("fatal", `Access to this job source was refused (HTTP ${res.status})`, { status: res.status });
    if (!res.ok) throw new SourceError("fatal", `Unexpected response from the job source (HTTP ${res.status})`, { status: res.status });

    let body;
    try {
      body = await res.text();
    } catch (e) {
      if (signal && signal.aborted) throw new SourceError("aborted", "Request cancelled");
      throw new SourceError("transient", "The response could not be read", { cause: e });
    }
    if (body.length > MAX_BODY_CHARS) throw new SourceError("fatal", "The response was larger than the allowed size");
    try {
      return JSON.parse(body);
    } catch {
      throw new SourceError("malformed", "The job source returned data that is not valid JSON");
    }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}
