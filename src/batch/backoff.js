// Exponential backoff with jitter. Pure; `random` is injectable so tests are deterministic.
export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

// attempt is 1-based (1 = first retry). Returns a delay in milliseconds.
//   exponential: baseMs * factor^(attempt-1), capped at maxMs, then +/- `jitter` (fraction) of that value.
//   retryAfterMs (from a Retry-After header) is a floor: we never retry sooner than the server asked.
export function computeDelay(attempt, { baseMs = 1000, factor = 2, maxMs = 30000, jitter = 0.3, retryAfterMs = null } = {}, random = Math.random) {
  const n = Math.max(1, Math.floor(attempt) || 1);
  const exp = Math.min(maxMs, baseMs * Math.pow(factor, n - 1));
  const spread = exp * jitter;
  let delay = Math.max(0, exp + (random() * 2 - 1) * spread);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) delay = Math.max(delay, Math.min(retryAfterMs, MAX_RETRY_AFTER_MS));
  return Math.round(delay);
}
