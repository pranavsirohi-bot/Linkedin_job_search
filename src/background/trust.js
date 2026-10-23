// Decides which message senders may use the database/auth handlers.
//
// Trusted:  this extension's own pages (popup, saved-jobs page), including when an extension page is open in a tab.
// Rejected: content scripts (their sender.url is the linkedin.com page), other extensions, and anything without a URL.
//
// The check is on the sender's ORIGIN, not on sender.tab: extension pages opened in a tab also carry sender.tab,
// so "no tab" is not a reliable test.
export function makeIsTrustedSender(runtimeId) {
  return (sender) => {
    if (!sender || sender.id !== runtimeId || typeof sender.url !== "string") return false;
    try {
      const u = new URL(sender.url);
      return u.protocol === "chrome-extension:" && u.hostname === runtimeId;
    } catch {
      return false;
    }
  };
}

// Our own content script, in the top frame of a www.linkedin.com tab. Used ONLY for the data-free "page changed"
// ping of auto-save; such senders can never reach the database handlers.
export function makeIsLinkedInContentSender(runtimeId) {
  return (sender) => {
    if (!sender || sender.id !== runtimeId || typeof sender.url !== "string") return false;
    if (!sender.tab || !Number.isInteger(sender.tab.id) || sender.frameId !== 0) return false;
    try {
      const u = new URL(sender.url);
      return u.protocol === "https:" && u.hostname === "www.linkedin.com";
    } catch {
      return false;
    }
  };
}
