// A minimal fake of the parts of supabase-js the app uses. It records every call so tests can assert on the
// exact query that would be sent. It does NOT emulate PostgREST: translating these calls into HTTP is supabase-js's
// job and is only verified against a real project.
export function fakeClient({ onQuery, onRpc, session = null, auth = {} } = {}) {
  const calls = [];
  const authLog = []; // names of auth methods called, in order
  let current = session; // stored session (stateful, like supabase-js with chrome.storage)
  let anonCount = 0;

  const builder = (table) => {
    const ops = [["from", table]];
    calls.push(ops);
    const b = {};
    for (const m of ["select", "insert", "update", "delete", "eq", "is", "in", "ilike", "contains", "textSearch", "order", "range", "maybeSingle", "single"]) {
      b[m] = (...args) => { ops.push([m, ...args]); return b; };
    }
    b.then = (resolve, reject) => {
      const out = typeof onQuery === "function" ? onQuery(ops) : onQuery;
      return Promise.resolve(out ?? { data: [], error: null }).then(resolve, reject);
    };
    return b;
  };

  const logged = (name, fn) => async (...args) => { authLog.push(name); return fn(...args); };

  return {
    calls,
    authLog,
    anonymousUsersCreated: () => anonCount,
    rpcCalls: () => calls.filter((c) => c[0][0] === "rpc"),
    from: builder,
    rpc(name, args) {
      calls.push([["rpc", name, args]]);
      const out = typeof onRpc === "function" ? onRpc(name, args) : onRpc;
      return Promise.resolve(out ?? { data: { inserted: 0, duplicates: 0 }, error: null });
    },
    auth: {
      getSession: logged("getSession", async () => ({ data: { session: current }, error: null })),
      refreshSession: logged("refreshSession", async () => ({ data: { session: current }, error: current ? null : { name: "AuthApiError", message: "no session" } })),
      signInAnonymously: logged("signInAnonymously", async () => {
        anonCount += 1;
        const user = { id: `anon-user-${anonCount}`, is_anonymous: true };
        current = { user };
        return { data: { user, session: current }, error: null };
      }),
      signOut: logged("signOut", async () => { current = null; return { error: null }; }),
      ...auth,
    },
  };
}

export const ops = (calls, i = 0) => Object.fromEntries(calls[i].map(([k, ...v]) => [k, v]));
export const opNames = (calls, i = 0) => calls[i].map(([k]) => k);
