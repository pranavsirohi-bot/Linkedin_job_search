// Source B: Greenhouse public job boards, via the documented Job Board API
// (https://docs.greenhouse.io/job-board.html).
//
// Documented and verified against live responses:
//   GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs        -> { jobs: [...], meta: { total } }
//        returns every job for the board in ONE response (no pagination is documented); the optional
//        `content=true` parameter adds descriptions, which this adapter does not need.
//   GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{id}   -> one job with `content`
//        (HTML, entity-escaped), departments, offices, and `pay_input_ranges` when ?pay_transparency=true.
//   "Authentication is not required for any GET endpoints." Unknown boards/jobs answer HTTP 404.
// Rate limits are not documented, so requests are sequential and paced by the run controller, and 429 / Retry-After
// is honoured. The API has no server-side search, so the optional keyword filter is applied locally to titles.
//
// The user chooses which company boards to read (the board token is the last part of a company's
// boards.greenhouse.io / job-boards.greenhouse.io URL). Each saved job keeps its original URL for attribution.
import { safeHttpsUrl } from "../db/job-mapper.js";
import { SourceError, fetchJson as defaultFetchJson } from "./http.js";
import { htmlToText, plainLine } from "./text.js";

export const GREENHOUSE_API = "https://boards-api.greenhouse.io/v1/boards";
export const BOARD_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const MAX_BOARDS = 10;

const fmtMoney = (cents) => (Number(cents) / 100).toLocaleString("en-US", { maximumFractionDigits: 0 });

function formatPay(ranges) {
  if (!Array.isArray(ranges) || !ranges.length) return "";
  const r = ranges.find((x) => x && Number.isFinite(Number(x.min_cents)) && Number.isFinite(Number(x.max_cents)));
  if (!r) return "";
  const label = plainLine(r.title || "", 80).replace(/[:\s]+$/, "");
  const cur = /^[A-Z]{3}$/.test(r.currency_type || "") ? `${r.currency_type} ` : "";
  return `${cur}${fmtMoney(r.min_cents)} - ${fmtMoney(r.max_cents)}${label ? ` (${label})` : ""}`;
}

function workplaceFromLocation(name) {
  const t = String(name || "");
  if (/\bhybrid\b/i.test(t)) return "Hybrid";
  if (/\bremote\b/i.test(t)) return "Remote"; // heuristic: Greenhouse has no workplace-type field
  return "";
}

const isoDay = (v) => {
  const m = String(v || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
};

export function createGreenhouseSource({ fetchJson = defaultFetchJson, now = () => Date.now(), listCacheMs = 60000 } = {}) {
  const listCache = new Map(); // board -> { at, jobs }  (volatile; a cold service worker simply refetches)

  async function getList(board, signal) {
    const hit = listCache.get(board);
    if (hit && now() - hit.at < listCacheMs) return hit.jobs;
    const data = await fetchJson(`${GREENHOUSE_API}/${encodeURIComponent(board)}/jobs`, { signal });
    if (!data || !Array.isArray(data.jobs)) throw new SourceError("malformed", "The board list did not have the expected shape");
    const jobs = data.jobs.filter((j) => j && (typeof j.id === "number" || /^\d+$/.test(String(j.id))) && typeof j.title === "string");
    listCache.set(board, { at: now(), jobs });
    return jobs;
  }

  return {
    id: "greenhouse",
    label: "Greenhouse company job boards",
    heavyParams: [],

    validateParams(params) {
      const errors = [];
      const raw = Array.isArray(params && params.boards) ? params.boards : [];
      const boards = [];
      for (const b of raw) {
        const token = String(b == null ? "" : b).trim();
        if (!token) continue;
        if (!BOARD_TOKEN_RE.test(token)) { errors.push(`"${plainLine(token, 40)}" is not a valid board token (letters, digits, - and _ only).`); continue; }
        if (!boards.some((x) => x.toLowerCase() === token.toLowerCase())) boards.push(token);
      }
      if (!boards.length && !errors.length) errors.push("Enter at least one Greenhouse board token.");
      if (boards.length > MAX_BOARDS) errors.push(`At most ${MAX_BOARDS} boards per run.`);
      const keyword = plainLine((params && params.keyword) || "", 100);
      return errors.length ? { ok: false, errors } : { ok: true, params: { boards, keyword } };
    },

    async search(params, cursor, { pageSize, signal }) {
      const b = cursor && Number.isInteger(cursor.b) && cursor.b >= 0 ? cursor.b : 0;
      const o = cursor && Number.isInteger(cursor.o) && cursor.o >= 0 ? cursor.o : 0;
      if (b >= params.boards.length) return { refs: [], nextCursor: null };
      const board = params.boards[b];
      const nextBoard = b + 1 < params.boards.length ? { b: b + 1, o: 0 } : null;

      let jobs;
      try {
        jobs = await getList(board, signal);
      } catch (e) {
        if (e instanceof SourceError && e.kind === "not-found") {
          return { refs: [], nextCursor: nextBoard, warnings: [`Board "${board}" was not found on Greenhouse.`] };
        }
        throw e;
      }
      const kw = (params.keyword || "").toLowerCase();
      const matching = kw ? jobs.filter((j) => j.title.toLowerCase().includes(kw)) : jobs;
      const slice = matching.slice(o, o + pageSize);
      const nextCursor = o + pageSize < matching.length ? { b, o: o + pageSize } : nextBoard;
      return {
        refs: slice.map((j) => ({ externalId: `${board}:${j.id}`, board, id: String(j.id), title: j.title, url: j.absolute_url, updatedAt: j.updated_at })),
        nextCursor,
        total: matching.length,
      };
    },

    describeCursor(cursor, params) {
      const board = params && params.boards ? params.boards[cursor.b] : null;
      return board ? `board "${board}", from job ${cursor.o + 1}` : "";
    },

    async getDetails(ref, { signal }) {
      if (!ref || !BOARD_TOKEN_RE.test(String(ref.board)) || !/^\d+$/.test(String(ref.id))) throw new SourceError("malformed", "Invalid job reference");
      return fetchJson(`${GREENHOUSE_API}/${encodeURIComponent(ref.board)}/jobs/${encodeURIComponent(ref.id)}?pay_transparency=true`, { signal });
    },

    normalize(raw, ref) {
      if (!raw || typeof raw !== "object" || raw.id == null || typeof raw.title !== "string") return null;
      const board = ref.board;
      const id = String(raw.id);
      const url = safeHttpsUrl(raw.absolute_url) || `https://boards.greenhouse.io/${encodeURIComponent(board)}/jobs/${encodeURIComponent(id)}`;
      const locationName = raw.location && typeof raw.location.name === "string" ? raw.location.name : "";
      const published = isoDay(raw.first_published) || isoDay(raw.updated_at);
      const deadline = typeof raw.application_deadline === "string" ? Date.parse(raw.application_deadline) : NaN;
      const closed = Number.isFinite(deadline) && deadline < now();
      const depts = Array.isArray(raw.departments) ? raw.departments.map((d) => plainLine(d && d.name, 80)).filter(Boolean) : [];
      return {
        provider: "greenhouse",
        externalId: `${board}:${id}`,
        url,
        title: plainLine(raw.title, 500),
        company: plainLine(raw.company_name || board, 500),
        location: plainLine(locationName, 500),
        postedText: published ? `Published ${published}` : "",
        postedDateApprox: published,
        workplaceType: workplaceFromLocation(locationName),
        // A job returned by the public board is published and accepting applications unless its deadline has passed.
        applicationStatus: closed ? "closed" : "open",
        applicationStatusText: closed ? "Application deadline has passed" : "",
        description: htmlToText(raw.content, { escaped: true, maxLength: 100000 }),
        salary: formatPay(raw.pay_input_ranges),
        otherPills: depts,
        source: "detail",
        collectedAt: new Date(now()).toISOString(),
      };
    },
  };
}
