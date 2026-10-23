import test from "node:test";
import assert from "node:assert/strict";
import { makeIsTrustedSender } from "../../src/background/trust.js";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const trusted = makeIsTrustedSender(ID);

test("popup page is trusted", () => {
  assert.equal(trusted({ id: ID, url: `chrome-extension://${ID}/src/popup/popup.html` }), true);
});

test("an extension page open in a browser tab (saved-jobs page) is trusted even though sender.tab is set", () => {
  assert.equal(trusted({ id: ID, tab: { id: 7 }, url: `chrome-extension://${ID}/src/library/library.html` }), true);
});

test("content scripts are rejected: same extension id, but the sender url is the LinkedIn page", () => {
  assert.equal(trusted({ id: ID, tab: { id: 7 }, url: "https://www.linkedin.com/jobs/view/4480218579/" }), false);
  assert.equal(trusted({ id: ID, tab: { id: 7 }, url: "https://www.linkedin.com/jobs/view/1/", origin: `chrome-extension://${ID}` }), false);
});

test("other extensions, spoofed hosts, missing or malformed senders are rejected", () => {
  const other = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
  assert.equal(trusted({ id: other, url: `chrome-extension://${other}/popup.html` }), false);
  assert.equal(trusted({ id: ID, url: `chrome-extension://${other}/popup.html` }), false);
  assert.equal(trusted({ id: ID, url: `chrome-extension://${ID}.evil.example/x` }), false);
  assert.equal(trusted({ id: ID, url: `https://${ID}/x` }), false);
  assert.equal(trusted({ id: ID, url: "not a url" }), false);
  assert.equal(trusted({ id: ID }), false);
  assert.equal(trusted({ url: `chrome-extension://${ID}/x` }), false);
  assert.equal(trusted(undefined), false);
  assert.equal(trusted(null), false);
});
