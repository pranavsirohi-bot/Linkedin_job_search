import test from "node:test";
import assert from "node:assert/strict";
import { fakeClient } from "./fake-client.mjs";
import { ERR } from "../../src/db/errors.js";
import { ensureSession, recoverSession, getCurrentUser } from "../../src/db/auth.js";
import { checkConfig, isConfigured, SUPABASE_CONFIG } from "../../src/shared/supabase-config.js";
import { createChromeStorageAdapter } from "../../src/db/storage-adapter.js";
import { createHandlers } from "../../src/background/handlers.js";
import { MSG } from "../../src/shared/messages.js";

const EXISTING = { user: { id: "existing-user", is_anonymous: true } };
const code = (p) => p.then(() => null, (e) => e.code);
const retryableErr = () => ({ name: "AuthRetryableFetchError", message: "Failed to fetch", status: 0 });

// ------------------------------------------------------------------ config safety (unchanged behaviour)
test("the shipped placeholder config is reported as not configured", () => {
  assert.equal(isConfigured({ url: "https://YOUR-PROJECT-REF.supabase.co", publishableKey: "sb_publishable_YOUR_KEY_HERE" }), false);
  assert.equal(typeof isConfigured(SUPABASE_CONFIG), "boolean");
});

test("a well-formed project URL + publishable key is accepted", () => {
  const cfg = { url: "https://abcdefghijklmnop.supabase.co", publishableKey: "sb_publishable_abcdefghijklmnopqrstuv" };
  assert.deepEqual(checkConfig(cfg), { ok: true, reason: "" });
});

test("secret and service-role keys are refused (never ship privileged keys in the extension)", () => {
  const url = "https://abcdefghijklmnop.supabase.co";
  assert.equal(checkConfig({ url, publishableKey: "sb_secret_abcdefghijklmnopqrstuvwxyz" }).ok, false);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const serviceJwt = `${b64({ alg: "HS256" })}.${b64({ role: "service_role" })}.sig`;
  const anonJwt = `${b64({ alg: "HS256" })}.${b64({ role: "anon" })}.sig`;
  assert.match(checkConfig({ url, publishableKey: serviceJwt }).reason, /secret|service/i);
  assert.equal(checkConfig({ url, publishableKey: anonJwt }).ok, true);
});

test("non-Supabase and non-https URLs are refused", () => {
  const key = "sb_publishable_abcdefghijklmnopqrstuv";
  for (const url of ["https://evil.example", "http://abcdefghijklmnop.supabase.co", "https://abcdefghijklmnop.supabase.co.evil.com", ""]) {
    assert.equal(checkConfig({ url, publishableKey: key }).ok, false, url);
  }
});

// ------------------------------------------------------------------ anonymous session: reuse, create, single-flight
test("ensureSession reuses an existing session and never creates a new user", async () => {
  const client = fakeClient({ session: EXISTING });
  const s = await ensureSession(client);
  assert.deepEqual(s, { user: { id: "existing-user", email: "", isAnonymous: true }, created: false, replaced: false });
  assert.equal(client.anonymousUsersCreated(), 0);
  await ensureSession(client);
  await ensureSession(client);
  assert.equal(client.anonymousUsersCreated(), 0, "opening the popup repeatedly must not mint new users");
});

test("ensureSession creates exactly one anonymous user when none exists, then reuses it", async () => {
  const client = fakeClient();
  const first = await ensureSession(client);
  assert.equal(first.created, true);
  assert.equal(first.replaced, false);
  assert.equal(first.user.isAnonymous, true);
  const second = await ensureSession(client);
  assert.equal(second.created, false);
  assert.equal(second.user.id, first.user.id);
  assert.equal(client.anonymousUsersCreated(), 1);
});

test("concurrent callers share one resolution: only one anonymous user is created", async () => {
  const client = fakeClient();
  const results = await Promise.all(Array.from({ length: 10 }, () => ensureSession(client)));
  assert.equal(client.anonymousUsersCreated(), 1);
  assert.equal(new Set(results.map((r) => r.user.id)).size, 1);
  assert.equal(client.authLog.filter((n) => n === "signInAnonymously").length, 1);
});

test("a failed attempt does not wedge later attempts (in-flight state is cleared)", async () => {
  let fail = true;
  const client = fakeClient({ auth: { getSession: async () => (fail ? { data: { session: null }, error: retryableErr() } : { data: { session: EXISTING }, error: null }) } });
  assert.equal(await code(ensureSession(client)), ERR.NETWORK);
  fail = false;
  assert.equal((await ensureSession(client)).user.id, "existing-user");
});

// ------------------------------------------------------------------ never orphan a profile on a flaky connection
test("network failure while reading/refreshing the stored session does NOT create a new user", async () => {
  const client = fakeClient({ auth: { getSession: async () => ({ data: { session: null }, error: retryableErr() }) } });
  assert.equal(await code(ensureSession(client)), ERR.NETWORK);
  assert.equal(client.anonymousUsersCreated(), 0);
  const thrower = fakeClient({ auth: { getSession: async () => { throw new TypeError("Failed to fetch"); } } });
  assert.equal(await code(ensureSession(thrower)), ERR.NETWORK);
  assert.equal(thrower.anonymousUsersCreated(), 0);
  const serverDown = fakeClient({ auth: { getSession: async () => ({ data: { session: null }, error: { name: "AuthApiError", status: 503, message: "unavailable" } }) } });
  assert.equal(await code(ensureSession(serverDown)), ERR.UNKNOWN); // "service unavailable": retryable, session kept
  assert.equal(serverDown.anonymousUsersCreated(), 0);
});

test("a permanently unrecoverable stored session is replaced and flagged", async () => {
  const client = fakeClient({ auth: { getSession: async () => ({ data: { session: null }, error: { name: "AuthApiError", status: 400, code: "refresh_token_not_found", message: "Invalid Refresh Token: Refresh Token Not Found" } }) } });
  const s = await ensureSession(client);
  assert.equal(s.created, true);
  assert.equal(s.replaced, true, "caller must be told earlier jobs are no longer reachable");
});

test("anonymous sign-in failures map to clear errors", async () => {
  const mk = (err) => fakeClient({ auth: { signInAnonymously: async () => ({ data: {}, error: err }) } });
  await assert.rejects(ensureSession(mk({ code: "anonymous_provider_disabled", message: "Anonymous sign-ins are disabled" })),
    (e) => e.code === ERR.AUTH_FAILED && /Allow anonymous sign-ins/.test(e.message));
  await assert.rejects(ensureSession(mk({ code: "captcha_failed", message: "x" })), (e) => e.code === ERR.AUTH_FAILED && /CAPTCHA/.test(e.message));
  await assert.rejects(ensureSession(mk({ code: "over_request_rate_limit", status: 429, message: "x" })), (e) => e.code === ERR.RATE_LIMITED);
  await assert.rejects(ensureSession(mk({ message: "TypeError: Failed to fetch" })), (e) => e.code === ERR.NETWORK);
  const thrower = fakeClient({ auth: { signInAnonymously: async () => { throw new TypeError("Failed to fetch"); } } });
  assert.equal(await code(ensureSession(thrower)), ERR.NETWORK);
  const empty = fakeClient({ auth: { signInAnonymously: async () => ({ data: { user: null }, error: null }) } });
  assert.equal(await code(ensureSession(empty)), ERR.AUTH_FAILED);
});

// ------------------------------------------------------------------ recovery after the server rejects the token
test("recoverSession: a successful refresh keeps the same user", async () => {
  const client = fakeClient({ session: EXISTING });
  const s = await recoverSession(client);
  assert.deepEqual([s.user.id, s.created, s.replaced], ["existing-user", false, false]);
  assert.equal(client.anonymousUsersCreated(), 0);
});

test("recoverSession: transient refresh failure surfaces NETWORK and keeps the session", async () => {
  const client = fakeClient({ session: EXISTING, auth: { refreshSession: async () => ({ data: { session: null }, error: retryableErr() }) } });
  assert.equal(await code(recoverSession(client)), ERR.NETWORK);
  assert.equal(client.anonymousUsersCreated(), 0);
  assert.ok(!client.authLog.includes("signOut"));
});

test("recoverSession: permanent failure clears the dead session locally and starts a new profile (flagged)", async () => {
  const client = fakeClient({ session: EXISTING, auth: { refreshSession: async () => ({ data: { session: null }, error: { name: "AuthApiError", status: 400, message: "Invalid Refresh Token" } }) } });
  const s = await recoverSession(client);
  assert.deepEqual([s.created, s.replaced], [true, true]);
  assert.ok(client.authLog.includes("signOut"));
});

test("getCurrentUser reads without creating a user", async () => {
  assert.deepEqual(await getCurrentUser(fakeClient({ session: EXISTING })), { id: "existing-user", email: "", isAnonymous: true });
  const none = fakeClient();
  assert.equal(await getCurrentUser(none), null);
  assert.equal(none.anonymousUsersCreated(), 0);
});

// ------------------------------------------------------------------ session storage adapter
test("chrome.storage adapter reads, writes and removes under a prefix", async () => {
  const mem = {};
  const area = {
    get: async (k) => (k in mem ? { [k]: mem[k] } : {}),
    set: async (o) => Object.assign(mem, o),
    remove: async (k) => { delete mem[k]; },
  };
  const a = createChromeStorageAdapter(area, "p:");
  assert.equal(await a.getItem("tok"), null);
  await a.setItem("tok", "v");
  assert.deepEqual(Object.keys(mem), ["p:tok"]);
  assert.equal(await a.getItem("tok"), "v");
  await a.removeItem("tok");
  assert.equal(await a.getItem("tok"), null);
});

// ------------------------------------------------------------------ service-worker handlers
const OK_CFG = () => ({ ok: true, reason: "" });
const POPUP = { id: "ext", url: "chrome-extension://ext/src/popup/popup.html" };
const CONTENT_SCRIPT = { id: "ext", tab: { id: 5 }, url: "https://www.linkedin.com/jobs/" };
const trusted = (s) => !!s && s.id === "ext" && !s.tab;
const jobs = [{ source: "detail", jobId: "4480218579", url: "https://www.linkedin.com/jobs/view/4480218579/", title: "T", company: "C" }];
const mkHandle = (client, checkConfig = OK_CFG) => createHandlers({ getClient: () => client, checkConfig, isTrustedSender: trusted });
const SAVED = { data: { inserted: 1, duplicates: 0 }, error: null };

test("handlers: AUTH_STATUS creates the anonymous session once and reports it", async () => {
  const client = fakeClient();
  const handle = mkHandle(client);
  const a = await handle({ type: MSG.AUTH_STATUS }, POPUP);
  assert.equal(a.ok, true);
  assert.equal(a.created, true);
  assert.equal(a.user.isAnonymous, true);
  const b = await handle({ type: MSG.AUTH_STATUS }, POPUP);
  assert.equal(b.created, false);
  assert.equal(b.user.id, a.user.id);
  assert.equal(client.anonymousUsersCreated(), 1);
});

test("handlers: no sign-in / sign-up / sign-out messages exist any more", () => {
  const handle = mkHandle(fakeClient());
  for (const t of ["AUTH_SIGN_IN", "AUTH_SIGN_UP", "AUTH_SIGN_OUT"]) assert.equal(handle.handles(t), false, t);
});

test("handlers: SAVE_JOBS first-ever call transparently creates the session, then saves", async () => {
  const client = fakeClient({ onRpc: SAVED });
  const res = await mkHandle(client)({ type: MSG.SAVE_JOBS, jobs }, POPUP);
  assert.deepEqual(res, { ok: true, result: { total: 1, inserted: 1, duplicates: 0, rejected: [] } });
  assert.equal(client.anonymousUsersCreated(), 1);
});

test("handlers: ownership never comes from the popup (user ids in the message or jobs are not sent)", async () => {
  const client = fakeClient({ session: EXISTING, onRpc: SAVED });
  await mkHandle(client)({ type: MSG.SAVE_JOBS, userId: "evil", user_id: "evil", user: { id: "evil" }, jobs: [{ ...jobs[0], user_id: "evil", userId: "evil", owner: "evil" }] }, POPUP);
  const sent = JSON.stringify(client.rpcCalls().map((c) => c[0][2]));
  assert.doesNotMatch(sent, /evil|user_id|userId|owner/);
});

test("handlers: concurrent popup requests create one anonymous user in total", async () => {
  const client = fakeClient({ onRpc: SAVED, onQuery: { data: [], count: 0, error: null } });
  const handle = mkHandle(client);
  const out = await Promise.all([
    handle({ type: MSG.AUTH_STATUS }, POPUP), handle({ type: MSG.AUTH_STATUS }, POPUP),
    handle({ type: MSG.COUNT_SAVED }, POPUP), handle({ type: MSG.SAVE_JOBS, jobs }, POPUP), handle({ type: MSG.COUNT_SAVED }, POPUP),
  ]);
  assert.ok(out.every((r) => r.ok), JSON.stringify(out));
  assert.equal(client.anonymousUsersCreated(), 1);
});

test("handlers: service-worker restart reuses the persisted session (fresh handlers, same stored session)", async () => {
  const client = fakeClient();
  await mkHandle(client)({ type: MSG.AUTH_STATUS }, POPUP); // creates
  const afterRestart = mkHandle(client); // new handler set = new worker instance; storage (client state) persists
  const res = await afterRestart({ type: MSG.AUTH_STATUS }, POPUP);
  assert.equal(res.created, false);
  assert.equal(client.anonymousUsersCreated(), 1);
});

test("handlers: network failure during session setup returns NETWORK, makes no DB call, creates no user", async () => {
  const client = fakeClient({ auth: { getSession: async () => ({ data: { session: null }, error: retryableErr() }) } });
  const handle = mkHandle(client);
  for (const m of [{ type: MSG.AUTH_STATUS }, { type: MSG.SAVE_JOBS, jobs }, { type: MSG.COUNT_SAVED }]) {
    const res = await handle(m, POPUP);
    assert.equal(res.ok, false);
    assert.equal(res.error.code, ERR.NETWORK);
  }
  assert.equal(client.calls.length, 0);
  assert.equal(client.anonymousUsersCreated(), 0);
});

test("handlers: server rejects the token -> recover once and retry the same save", async () => {
  let n = 0;
  const client = fakeClient({ session: EXISTING, onRpc: () => (++n === 1 ? { data: null, error: { status: 401, code: "PGRST301", message: "JWT expired" } } : SAVED) });
  const res = await mkHandle(client)({ type: MSG.SAVE_JOBS, jobs }, POPUP);
  assert.equal(res.ok, true);
  assert.equal(res.result.inserted, 1);
  assert.equal(client.rpcCalls().length, 2);
  assert.equal(res.sessionReplaced, undefined, "refresh succeeded, same profile");
});

test("handlers: unrecoverable token -> new profile, flagged with sessionReplaced, job still saved", async () => {
  let n = 0;
  const client = fakeClient({
    session: EXISTING,
    auth: { refreshSession: async () => ({ data: { session: null }, error: { name: "AuthApiError", status: 400, message: "Invalid Refresh Token" } }) },
    onRpc: () => (++n === 1 ? { data: null, error: { status: 401, message: "JWT expired" } } : SAVED),
  });
  const res = await mkHandle(client)({ type: MSG.SAVE_JOBS, jobs }, POPUP);
  assert.equal(res.ok, true);
  assert.equal(res.sessionReplaced, true);
  assert.equal(client.anonymousUsersCreated(), 1);
});

test("handlers: recovery is attempted only once; a second auth failure is reported, not looped", async () => {
  const client = fakeClient({ session: EXISTING, onRpc: { data: null, error: { status: 401, message: "JWT expired" } } });
  const res = await mkHandle(client)({ type: MSG.SAVE_JOBS, jobs }, POPUP);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, ERR.AUTH_REQUIRED);
  assert.equal(client.rpcCalls().length, 2);
});

test("handlers: requests from content scripts / web contexts are rejected before any auth or DB work", async () => {
  const client = fakeClient();
  for (const type of [MSG.SAVE_JOBS, MSG.LIST_JOBS, MSG.AUTH_STATUS, MSG.DELETE_JOB, MSG.COUNT_SAVED]) {
    const res = await mkHandle(client)({ type, jobs }, CONTENT_SCRIPT);
    assert.equal(res.error.code, ERR.PERMISSION, type);
  }
  assert.equal((await mkHandle(client)({ type: MSG.SAVE_JOBS, jobs }, undefined)).error.code, ERR.PERMISSION);
  assert.equal(client.calls.length, 0);
  assert.equal(client.authLog.length, 0, "no session is created on behalf of an untrusted sender");
});

test("handlers: unconfigured project -> NOT_CONFIGURED, AUTH_STATUS explains it, PING works, no user created", async () => {
  const client = fakeClient();
  const handle = mkHandle(client, () => ({ ok: false, reason: "Supabase project URL is not configured." }));
  assert.equal((await handle({ type: MSG.SAVE_JOBS, jobs }, POPUP)).error.code, ERR.NOT_CONFIGURED);
  assert.deepEqual(await handle({ type: MSG.AUTH_STATUS }, POPUP), { ok: true, configured: false, reason: "Supabase project URL is not configured.", user: null });
  assert.equal((await handle({ type: MSG.PING }, CONTENT_SCRIPT)).ok, true);
  assert.equal(client.calls.length, 0);
  assert.equal(client.anonymousUsersCreated(), 0);
});

test("handlers: payload validation for SAVE_JOBS", async () => {
  const handle = mkHandle(fakeClient({ session: EXISTING }));
  for (const bad of [undefined, [], "x", { length: 1 }]) {
    assert.equal((await handle({ type: MSG.SAVE_JOBS, jobs: bad }, POPUP)).error.code, ERR.VALIDATION);
  }
  const tooMany = Array.from({ length: 501 }, () => jobs[0]);
  assert.equal((await handle({ type: MSG.SAVE_JOBS, jobs: tooMany }, POPUP)).error.code, ERR.VALIDATION);
});

test("handlers: database errors come back as { ok:false, error } with partial progress intact", async () => {
  const none = fakeClient({ session: EXISTING, onQuery: { data: [], error: null } });
  const res = await mkHandle(none)({ type: MSG.DELETE_JOB, id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }, POPUP);
  assert.equal(res.error.code, ERR.NOT_FOUND);
  const net = fakeClient({ session: EXISTING, onRpc: () => { throw new TypeError("Failed to fetch"); } });
  const r2 = await mkHandle(net)({ type: MSG.SAVE_JOBS, jobs }, POPUP);
  assert.equal(r2.error.code, ERR.NETWORK);
  assert.deepEqual(r2.error.partial, { inserted: 0, duplicates: 0 });
});

test("handlers: unknown message types are ignored", async () => {
  const handle = mkHandle(fakeClient());
  assert.equal(await handle({ type: "EXTRACT_PREVIEW" }, POPUP), undefined);
  assert.equal(handle.handles("EXTRACT_PREVIEW"), false);
  assert.equal(handle.handles(MSG.SAVE_JOBS), true);
  assert.equal(handle.handles("__proto__"), false);
  assert.equal(await handle(null, POPUP), undefined);
});
