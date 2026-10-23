// The set of job sources a run can use, and a shape check every source must pass.
import { createFileSource } from "./file-import.js";
import { createGreenhouseSource } from "./greenhouse.js";

// A JobSource is { id, label, heavyParams[], validateParams, search, getDetails, normalize } (see greenhouse.js
// and file-import.js). search() returns { refs, nextCursor, total?, warnings? } for one bounded page.
export function assertJobSource(source) {
  for (const key of ["validateParams", "search", "getDetails", "normalize"]) {
    if (typeof (source && source[key]) !== "function") throw new Error(`Job source "${source && source.id}" is missing ${key}()`);
  }
  if (typeof source.id !== "string" || !/^[a-z][a-z0-9_-]{1,30}$/.test(source.id)) throw new Error("Job source needs a valid id");
  if (!Array.isArray(source.heavyParams)) throw new Error(`Job source "${source.id}" needs heavyParams[]`);
  return source;
}

export function createSourceRegistry(deps = {}) {
  const sources = [createGreenhouseSource(deps), createFileSource()].map(assertJobSource);
  const byId = new Map(sources.map((s) => [s.id, s]));
  return {
    get: (id) => (typeof id === "string" && byId.has(id) ? byId.get(id) : null),
    list: () => sources.map((s) => ({ id: s.id, label: s.label })),
  };
}
