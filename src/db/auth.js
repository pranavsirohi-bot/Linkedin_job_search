// Supabase anonymous authentication. There is no email, password or account form: the extension creates an
// anonymous Supabase user once, keeps its session in chrome.storage.local, and reuses it.
//
// LIMITATION (by design of anonymous auth): the session is the only credential. If extension data is cleared or the
// extension is removed, that user and its saved jobs can no longer be reached.
import { DbError, ERR, toDbError } from "./errors.js";

const NETWORK_RE = /failed to fetch|networkerror|network request failed|fetch failed|load failed|err_internet|offline/i;

const publicUser = (u) => (u ? { id: u.id, email: "", isAnonymous: u.is_anonymous !== false } : null);

// A failure that says nothing about the stored session (no connection, server hiccup). Never treat these as
// "session lost": creating a new anonymous user here would orphan every job saved so far.
function isRetryable(err) {
  if (!err) return false;
  const status = typeof err.status === "number" ? err.status : undefined;
  return (
    err instanceof TypeError ||
    err.name === "AuthRetryableFetchError" ||
    NETWORK_RE.test(String(err.message || "")) ||
    status === 0 ||
    (status !== undefined && status >= 500) ||
    (typeof navigator !== "undefined" && navigator.onLine === false)
  );
}

function anonymousError(err) {
  const code = err && (err.code || err.error_code);
  if (code === "anonymous_provider_disabled") {
    return new DbError(
      ERR.AUTH_FAILED,
      "Anonymous sign-ins are turned off for this Supabase project. Enable \"Allow anonymous sign-ins\" under Authentication → Sign In / Providers."
    );
  }
  if (code === "captcha_failed") {
    return new DbError(
      ERR.AUTH_FAILED,
      "This Supabase project requires CAPTCHA for sign-ins, which this extension can't complete. Turn CAPTCHA protection off."
    );
  }
  if (code === "over_request_rate_limit" || code === "over_anonymous_sign_ins_limit" || (err && err.status === 429)) {
    return new DbError(ERR.RATE_LIMITED, "Too many profile-creation attempts. Wait a while and try again.");
  }
  return toDbError(err);
}

async function createAnonymous(client, replaced) {
  let data, error;
  try {
    ({ data, error } = await client.auth.signInAnonymously());
  } catch (e) {
    throw anonymousError(e);
  }
  if (error) throw anonymousError(error);
  if (!data || !data.user) throw new DbError(ERR.AUTH_FAILED, "Could not create a private profile. Try again.");
  return { user: publicUser(data.user), created: true, replaced };
}

// One in-flight resolution per client. Concurrent callers (popup opened twice, a save racing the status check)
// all await the same promise, so at most one anonymous user is created.
const inflight = new WeakMap();
function singleFlight(client, work) {
  if (!inflight.has(client)) {
    const p = work().finally(() => inflight.delete(client));
    inflight.set(client, p);
  }
  return inflight.get(client);
}

async function resolveSession(client) {
  let data, error;
  try {
    ({ data, error } = await client.auth.getSession()); // reads storage; refreshes an expired access token
  } catch (e) {
    throw toDbError(e);
  }
  if (data && data.session && data.session.user) {
    return { user: publicUser(data.session.user), created: false, replaced: false };
  }
  if (error && isRetryable(error)) throw toDbError(error); // keep the stored session; just report the problem
  // No session at all (first run) or a stored one that is permanently unrecoverable (e.g. refresh token revoked).
  return createAnonymous(client, !!error);
}

// Returns { user, created, replaced }:
//   created  - a new anonymous user was made during this call
//   replaced - a previous session existed but could not be restored, so earlier jobs are no longer reachable
export function ensureSession(client) {
  return singleFlight(client, () => resolveSession(client));
}

// Called after the server rejected our token (HTTP 401 / JWT error). Try a refresh first; only a permanent failure
// discards the stored session and starts a new anonymous profile.
export function recoverSession(client) {
  return singleFlight(client, async () => {
    let data, error;
    try {
      ({ data, error } = await client.auth.refreshSession());
    } catch (e) {
      throw toDbError(e);
    }
    if (data && data.session && data.session.user) {
      return { user: publicUser(data.session.user), created: false, replaced: false };
    }
    if (isRetryable(error)) throw toDbError(error);
    try {
      await client.auth.signOut({ scope: "local" }); // drop the dead session; never touches the server
    } catch {
      /* best effort */
    }
    return createAnonymous(client, true);
  });
}

// Current user from the stored session without creating one. Null when none exists.
export async function getCurrentUser(client) {
  try {
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    return publicUser(data && data.session && data.session.user);
  } catch (e) {
    throw toDbError(e);
  }
}
