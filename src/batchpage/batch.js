// Optional full-tab view of Batch collection. The main entry point is the extension popup; both mount the same UI
// (batch-ui.js) and drive the same run controller in the service worker.
import { initBatchUI } from "./batch-ui.js";

initBatchUI();
