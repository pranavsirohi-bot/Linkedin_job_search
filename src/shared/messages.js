// Message types shared by popup, background and content script.
// NOTE: the content script is a classic script and cannot import this file;
// it duplicates the three extraction types. Keep them in sync.
export const MSG = Object.freeze({
  PING: "PING",
  // popup -> content script (read-only extraction)
  GET_PAGE_INFO: "GET_PAGE_INFO",
  DIAGNOSE: "DIAGNOSE",
  EXTRACT_PREVIEW: "EXTRACT_PREVIEW",
  // popup -> service worker. AUTH_STATUS reuses the stored anonymous session or creates one (once).
  // There is deliberately no sign-in/sign-up/sign-out message and no way to name a user id.
  AUTH_STATUS: "AUTH_STATUS",
  SAVE_JOBS: "SAVE_JOBS",
  FIND_DUPLICATES: "FIND_DUPLICATES",
  COUNT_SAVED: "COUNT_SAVED",
  LIST_JOBS: "LIST_JOBS",
  GET_JOB: "GET_JOB",
  UPDATE_JOB: "UPDATE_JOB",
  DELETE_JOB: "DELETE_JOB",
  // Can the database store the extra detail fields yet (migration 20261022000200 applied)? Read-only, cached.
  SCHEMA_STATUS: "SCHEMA_STATUS",
  // popup / batch page -> service worker: batch run control. Extension pages only; the run itself lives in the worker.
  RUN_START: "RUN_START",
  RUN_PAUSE: "RUN_PAUSE",
  RUN_RESUME: "RUN_RESUME",
  RUN_STOP: "RUN_STOP",
  RUN_STATUS: "RUN_STATUS",
  RUN_DISMISS: "RUN_DISMISS",
  // popup -> service worker: auto-save while the user browses (the extension never clicks or navigates)
  WATCH_START: "WATCH_START",
  WATCH_STOP: "WATCH_STOP",
  WATCH_STATUS: "WATCH_STATUS",
  // content script -> service worker: "the page I am on changed". Carries no data; accepted only from our content
  // script in the tab being auto-saved, which the worker then reads itself.
  PAGE_CHANGED: "PAGE_CHANGED",
});
