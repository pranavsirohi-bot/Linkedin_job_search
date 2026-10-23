// Error model shared by the database and auth modules. Codes are stable strings the UI can switch on.
export const ERR = Object.freeze({
  NETWORK: "NETWORK",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  AUTH_FAILED: "AUTH_FAILED",
  PERMISSION: "PERMISSION",
  VALIDATION: "VALIDATION",
  NOT_FOUND: "NOT_FOUND",
  NOT_CONFIGURED: "NOT_CONFIGURED",
  RATE_LIMITED: "RATE_LIMITED",
  UNKNOWN: "UNKNOWN",
});

export class DbError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "DbError";
    this.code = code;
    Object.assign(this, extra); // e.g. { partial: { inserted, duplicates } }
  }
  toJSON() {
    return { code: this.code, message: this.message, ...(this.partial ? { partial: this.partial } : {}) };
  }
}

const NETWORK_RE = /failed to fetch|networkerror|network request failed|fetch failed|load failed|err_internet|offline/i;

// Normalise anything thrown or returned by supabase-js / fetch into a DbError.
export function toDbError(err) {
  if (err instanceof DbError) return err;
  const message = String((err && err.message) || err || "");
  const code = err && err.code != null ? String(err.code) : "";
  const status = err && typeof err.status === "number" ? err.status : 0;

  if (err instanceof TypeError || NETWORK_RE.test(message) || (typeof navigator !== "undefined" && navigator.onLine === false)) {
    return new DbError(ERR.NETWORK, "Can't reach the server. Check your connection and try again.", { cause: err });
  }
  if (status === 401 || code === "28000" || code === "PGRST301" || /jwt|not authenticated|refresh[_ ]token/i.test(message)) {
    return new DbError(ERR.AUTH_REQUIRED, "Your session has expired. Please sign in again.", { cause: err });
  }
  if (status === 403 || code === "42501") {
    return new DbError(ERR.PERMISSION, "You don't have permission to do that.", { cause: err });
  }
  if (status === 429 || code === "over_request_rate_limit") {
    return new DbError(ERR.RATE_LIMITED, "Too many requests. Wait a moment and try again.", { cause: err });
  }
  if (code === "PGRST116") return new DbError(ERR.NOT_FOUND, "Job not found.", { cause: err });
  if (code.startsWith("23") || code.startsWith("22")) {
    return new DbError(ERR.VALIDATION, `The data was rejected by the database (${code}).`, { cause: err });
  }
  if (status >= 500) return new DbError(ERR.UNKNOWN, "The service is temporarily unavailable. Try again shortly.", { cause: err });
  return new DbError(ERR.UNKNOWN, message || "Something went wrong.", { cause: err });
}
