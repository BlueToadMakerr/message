// A drop-in replacement for the parts of the Firebase SDK this site uses (Auth + Realtime Database), talking to server/qm_server.py.
// js/sdk.js loads it instead of the Google SDK when private mode is on. Same function names and shapes, so no other file changes.
import { privateBase } from "../mode.js";

const BASE = privateBase() || "";
const TOKEN_KEY = "qm-ptoken";
const api = async (name, body, tok = token) => {
  let r;
  try { r = await fetch(BASE + "/api/" + name, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" }); }
  catch (e) { throw Object.assign(new Error("Network error: can't reach the server"), { code: "auth/network-request-failed" }); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || "Request failed"), { code: j.code || "permission_denied", status: r.status, PERMISSION_DENIED: r.status === 403 });
  return j;
};

// ------------------------------------------------------------------ auth
let token = ""; try { token = localStorage.getItem(TOKEN_KEY) || ""; } catch (_) { /* ignore */ }
const authListeners = new Set();
class User {
  constructor(j) { this.uid = j.uid; this.email = j.email; this.emailVerified = true; this.displayName = j.displayName || null; this.photoURL = null; this.isAnonymous = false;
    this.metadata = { creationTime: j.creationTime, lastSignInTime: j.lastSignInTime }; this.providerData = [{ providerId: "password", uid: j.email, email: j.email }]; }
  getIdToken() { return Promise.resolve(token); }
  async reload() { await refresh(); }
  toJSON() { return { uid: this.uid, email: this.email }; }
}
const auth = { currentUser: null, config: {}, app: {}, name: "private", _ready: false };
const fire = () => authListeners.forEach(f => { try { f(auth.currentUser); } catch (e) { console.error(e); } });
function setSession(j) {
  token = j ? j.token : ""; try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch (_) { /* ignore */ }
  auth.currentUser = j ? new User(j.user) : null; auth._ready = true;
  stream.restart(); fire();
}
async function refresh() { const j = await api("auth/me"); token = j.token; try { localStorage.setItem(TOKEN_KEY, token); } catch (_) { /* ignore */ } auth.currentUser = new User(j.user); }
const boot = (async () => {
  if (!token) { auth._ready = true; return; }
  try { await refresh(); } catch (e) { if (e.status === 401) { token = ""; try { localStorage.removeItem(TOKEN_KEY); } catch (_) { /* ignore */ } auth.currentUser = null; } else if (!auth.currentUser) { /* offline: stay signed out until the server answers */ } }
  auth._ready = true;
})();
const codeFor = e => { const m = e.message || ""; e.code = /already registered/.test(m) ? "auth/email-already-in-use" : /valid email/.test(m) ? "auth/invalid-email" : /6 characters/.test(m) ? "auth/weak-password" : /closed/.test(m) ? "auth/operation-not-allowed" : e.code; return e; };
const authFn = {
  getAuth: () => auth,
  onAuthStateChanged: (a, cb) => { authListeners.add(cb); boot.then(() => { if (authListeners.has(cb)) cb(auth.currentUser); }); return () => authListeners.delete(cb); },
  onIdTokenChanged: (a, cb) => authFn.onAuthStateChanged(a, cb),
  signInWithEmailAndPassword: async (a, email, password) => { try { const j = await api("auth/login", { email, password }, ""); setSession(j); return { user: auth.currentUser }; } catch (e) { throw codeFor(e); } },
  createUserWithEmailAndPassword: async (a, email, password) => { try { const j = await api("auth/signup", { email, password }, ""); setSession(j); return { user: auth.currentUser }; } catch (e) { throw codeFor(e); } },
  signOut: async () => { setSession(null); },
  updatePassword: async (u, pw) => { throw Object.assign(new Error("Use the password dialog."), { code: "auth/requires-recent-login", pw }); },
  deleteUser: async () => { throw Object.assign(new Error("Re-enter your password to delete the account."), { code: "auth/requires-recent-login" }); },
  reauthenticateWithCredential: async (u, cred) => { try { await api("auth/login", { email: u.email, password: cred.password }, ""); pendingPw = cred.password; } catch (e) { throw Object.assign(new Error("Wrong password."), { code: "auth/wrong-password" }); } },
  EmailAuthProvider: { credential: (email, password) => ({ providerId: "password", email, password }) },
  GoogleAuthProvider: class { },
  sendEmailVerification: async () => {}, sendPasswordResetEmail: async () => { throw Object.assign(new Error("Password reset by e-mail isn't available on a private server. Ask the server owner to run: python3 qm_server.py passwd EMAIL NEWPASSWORD"), { code: "auth/operation-not-allowed" }); },
  signInWithPopup: async () => { throw Object.assign(new Error("Google sign-in isn't available on a private server."), { code: "auth/operation-not-allowed" }); },
  signInWithCredential: async () => { throw Object.assign(new Error("Not available on a private server."), { code: "auth/operation-not-allowed" }); },
  linkWithPopup: async () => { throw Object.assign(new Error("Not available on a private server."), { code: "auth/operation-not-allowed" }); },
  linkWithCredential: async () => { throw Object.assign(new Error("Not available on a private server."), { code: "auth/operation-not-allowed" }); },
  reauthenticateWithPopup: async () => { throw Object.assign(new Error("Not available on a private server."), { code: "auth/operation-not-allowed" }); },
  unlink: async () => { throw Object.assign(new Error("Not available on a private server."), { code: "auth/operation-not-allowed" }); },
  sendSignInLinkToEmail: async () => { throw Object.assign(new Error("Not available on a private server."), { code: "auth/operation-not-allowed" }); },
  updateProfile: async () => {}, updateEmail: async () => { throw Object.assign(new Error("Not available on a private server."), { code: "auth/operation-not-allowed" }); },
  reload: async () => { await refresh(); }, getIdToken: async () => token, setPersistence: async () => {},
  browserLocalPersistence: {}, indexedDBLocalPersistence: {}
};
let pendingPw = "";
// Password change / account deletion: the Firebase SDK calls updatePassword(user, new) right after reauthenticateWithCredential(user, cred) — the same order is used here.
authFn.updatePassword = async (u, pw) => { try { await api("auth/password", { old: pendingPw, new: pw }); } catch (e) { throw codeFor(e); } };
authFn.deleteUser = async () => { await api("auth/delete", { password: pendingPw }); setSession(null); };

// ------------------------------------------------------------------ database
const split = p => String(p || "").split("/").filter(Boolean);
class Reference {
  constructor(db, path) { this.db = db; this.path = split(path).join("/"); this.key = this.path ? this.path.split("/").pop() : null; this._spec = {}; }
  get parent() { return this.path.includes("/") ? new Reference(this.db, this.path.split("/").slice(0, -1).join("/")) : (this.path ? new Reference(this.db, "") : null); }
  get root() { return new Reference(this.db, ""); }
  toString() { return "private://" + this.path; }
}
class Query { constructor(refv, spec) { this.ref = refv; this._spec = spec; } }
const refOf = r => (r instanceof Query ? r.ref : r);
const specOf = r => (r instanceof Query ? r._spec : null);
class DataSnapshot {
  constructor(refv, val, items) { this.ref = refv; this.key = refv.key; this._v = val === undefined ? null : val; this._items = items || null; }
  val() { return this._v; } exportVal() { return this._v; } toJSON() { return this._v; }
  exists() { return this._v !== null && this._v !== undefined; }
  hasChildren() { return !!this._v && typeof this._v === "object" && Object.keys(this._v).length > 0; }
  hasChild(p) { return this.child(p).exists(); }
  get size() { return this._v && typeof this._v === "object" ? Object.keys(this._v).length : 0; }
  child(p) { let v = this._v; for (const k of split(p)) { v = v && typeof v === "object" && k in v ? v[k] : null; } return new DataSnapshot(new Reference(this.ref.db, (this.ref.path ? this.ref.path + "/" : "") + split(p).join("/")), v); }
  forEach(cb) {
    if (!this._v || typeof this._v !== "object") return false;
    const items = this._items || Object.keys(this._v).sort().map(k => [k, this._v[k]]);
    for (const [k, v] of items) if (cb(new DataSnapshot(new Reference(this.ref.db, (this.ref.path ? this.ref.path + "/" : "") + k), v)) === true) return true;
    return false;
  }
}
const db = { type: "private-database" };
const q = (r, extra) => new Query(refOf(r), { ...(specOf(r) || {}), ...extra });
const dbFn = {
  getDatabase: () => db,
  ref: (d, path) => new Reference(d || db, path),
  child: (r, p) => new Reference(r.db, (r.path ? r.path + "/" : "") + split(p).join("/")),
  query: (r, ...cs) => cs.reduce((acc, c) => c(acc), r instanceof Query ? r : new Query(r, {})),
  orderByKey: () => r => q(r, { orderBy: "key" }), orderByValue: () => r => q(r, { orderBy: "value" }), orderByChild: p => r => q(r, { orderBy: "child:" + p }),
  limitToLast: n => r => q(r, { limitLast: n }), limitToFirst: n => r => q(r, { limitFirst: n }),
  startAt: v => r => q(r, { startAt: v }), startAfter: v => r => q(r, { startAfter: v }), endAt: v => r => q(r, { endAt: v }), endBefore: v => r => q(r, { endBefore: v }), equalTo: v => r => q(r, { equalTo: v }),
  serverTimestamp: () => ({ ".sv": "timestamp" }),
  push: r => { const k = pushId(); return new Reference(r.db, (r.path ? r.path + "/" : "") + k); },
  set: (r, v) => write({ [r.path]: v === undefined ? null : v }),
  remove: r => write({ [r.path]: null }),
  update: (r, vals) => { const o = {}; for (const [k, v] of Object.entries(vals)) o[[r.path, split(k).join("/")].filter(Boolean).join("/")] = v === undefined ? null : v; return write(o); },
  get: async r => {
    const rf = refOf(r);
    if (rf.path === ".info/serverTimeOffset") return new DataSnapshot(rf, serverOffset);
    if (rf.path === ".info/connected") return new DataSnapshot(rf, stream.open);
    const j = await api("db/get", { path: rf.path, ...(specOf(r) && Object.keys(specOf(r)).length ? { query: specOf(r) } : {}) });
    if (j.items) return new DataSnapshot(rf, Object.fromEntries(j.items), j.items);
    return new DataSnapshot(rf, j.v);
  },
  onValue: (r, cb, err) => listen(r, "value", cb, err),
  onChildAdded: (r, cb, err) => listen(r, "child", cb, err, "added"),
  onChildChanged: (r, cb, err) => listen(r, "child", cb, err, "changed"),
  onChildRemoved: (r, cb, err) => listen(r, "child", cb, err, "removed"),
  onChildMoved: () => () => {},
  off: () => {},
  goOnline: () => stream.start(), goOffline: () => stream.stop(),
  onDisconnect: r => ({
    remove: () => disc(r, "r", null), set: v => disc(r, "s", v), update: v => disc(r, "u", v),
    cancel: () => { discOps.delete(r.path + "|r"); discOps.delete(r.path + "|s"); discOps.delete(r.path + "|u"); return stream.sendDisc(r.path + "|*", null, true); }
  }),
  runTransaction: async (r, fn) => {
    for (let i = 0; i < 12; i++) {
      const cur = (await dbFn.get(r)).val();
      const next = fn(cur);
      if (next === undefined) return { committed: false, snapshot: new DataSnapshot(r, cur) };
      const j = await api("db/tx", { path: r.path, expect: cur, value: next });
      if (j.ok) return { committed: true, snapshot: new DataSnapshot(r, next) };
      if (!j.conflict) throw Object.assign(new Error(j.error || "transaction failed"), { code: "permission_denied" });
    }
    throw new Error("transaction: too much contention");
  }
};
function write(updates) { return api("db/update", { updates }).then(() => undefined, e => { throw e; }); }

const CH = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
let lastPush = 0, lastRand = [];
function pushId() {
  let now = Date.now(); const dup = now === lastPush; lastPush = now;
  const ts = []; for (let i = 7; i >= 0; i--) { ts[i] = CH.charAt(now % 64); now = Math.floor(now / 64); }
  let id = ts.join("");
  if (!dup) { lastRand = []; for (let i = 0; i < 12; i++) lastRand[i] = Math.floor(Math.random() * 64); }
  else { let i; for (i = 11; i >= 0 && lastRand[i] === 63; i--) lastRand[i] = 0; lastRand[i]++; }
  for (let i = 0; i < 12; i++) id += CH.charAt(lastRand[i]);
  return "-" + id;
}

// ---- live connection (Server-Sent Events). New connection id every (re)connect; listeners and onDisconnect actions are registered again each time.
let serverOffset = 0;
fetch(BASE + "/api/time", { cache: "no-store" }).then(r => r.json()).then(j => { serverOffset = j.now - Date.now(); infoSet("offset"); }).catch(() => {});
const listeners = new Map();      // lid -> listener
const discOps = new Map();        // path|kind -> {updates}
let lidSeq = 0;
const infoSubs = new Set();
function infoSet() { infoSubs.forEach(f => f()); }
const stream = {
  es: null, cid: "", open: false, want: true, timer: null,
  start() { this.want = true; if (this.es || !token) return; this.connect(); },
  stop() { this.want = false; this.close(); },
  restart() { this.close(); if (this.want && token) this.connect(); },
  close() { if (this.es) { this.es.onerror = null; this.es.close(); this.es = null; } clearTimeout(this.timer); if (this.open) { this.open = false; infoSet(); } },
  connect() {
    this.cid = "c" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    const es = new EventSource(`${BASE}/api/stream?cid=${this.cid}&token=${encodeURIComponent(token)}`);
    this.es = es;
    es.addEventListener("hello", () => { this.open = true; infoSet(); for (const l of listeners.values()) this.register(l); for (const [k, u] of discOps) this.sendDisc(k, u.updates); });
    es.onmessage = e => { let d; try { d = JSON.parse(e.data); } catch (_) { return; } const l = listeners.get(d.lid); if (l) l.handle(d); };
    es.onerror = () => { if (this.es !== es) return; this.close(); if (this.want) this.timer = setTimeout(() => this.connect(), 1500); };
  },
  register(l) { api("listen", { cid: this.cid, lid: l.lid, path: l.ref.path, query: l.spec, mode: l.mode }).catch(e => l.fail(e)); },
  sendDisc(id, updates, cancel) { if (!this.open) return Promise.resolve(); return api("ondisconnect", { cid: this.cid, id, updates, cancel: !!cancel }).catch(() => {}); }
};
function disc(r, kind, v) {
  const id = r.path + "|" + kind;
  const updates = kind === "u" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [[r.path, k].filter(Boolean).join("/"), x])) : { [r.path]: v };
  discOps.set(id, { updates });
  return stream.sendDisc(id, updates);
}
function listen(r, mode, cb, err, kind) {
  const rf = refOf(r), spec = specOf(r) && Object.keys(specOf(r)).length ? specOf(r) : null;
  // browser-local pseudo nodes
  if (rf.path === ".info/connected" || rf.path === ".info/serverTimeOffset") {
    const f = () => cb(new DataSnapshot(rf, rf.path === ".info/connected" ? stream.open : serverOffset));
    infoSubs.add(f); setTimeout(f, 0); stream.start(); return () => infoSubs.delete(f);
  }
  const lid = "l" + (++lidSeq);
  let local = {}, lastJson = null, inited = false, dead = false;
  const snap = (k, v) => new DataSnapshot(new Reference(rf.db, (rf.path ? rf.path + "/" : "") + k), v);
  const l = {
    lid, ref: rf, spec, mode,
    fail: e => { if (!dead && err) err(e); },
    handle: d => {
      if (dead) return;
      try {
        if (mode === "value") {
          const j = JSON.stringify(d.v === undefined ? null : d.v); if (j === lastJson) return; lastJson = j;
          const v = Array.isArray(d.v) && spec ? Object.fromEntries(d.v) : d.v;
          cb(new DataSnapshot(rf, v, Array.isArray(d.v) && spec ? d.v : null)); return;
        }
        if (d.type === "init") {
          const next = Object.fromEntries(d.items), prevKeys = Object.keys(local);
          for (const [k, v] of d.items) { if (!(k in local)) { if (kind === "added") cb(snap(k, v)); } else if (JSON.stringify(local[k]) !== JSON.stringify(v) && kind === "changed") cb(snap(k, v)); }
          for (const k of prevKeys) if (!(k in next) && kind === "removed") cb(snap(k, local[k]));
          local = next; inited = true; return;
        }
        for (const k of d.del || []) { if (k in local) { const old = local[k]; delete local[k]; if (kind === "removed") cb(snap(k, old)); } }
        for (const [k, v] of d.ups || []) { const had = k in local; local[k] = v; if (!had) { if (kind === "added") cb(snap(k, v)); } else if (kind === "changed") cb(snap(k, v)); }
      } catch (e) { console.error(e); }
    }
  };
  listeners.set(lid, l);
  stream.start();
  if (stream.open) stream.register(l);
  return () => { dead = true; listeners.delete(lid); if (stream.open) api("unlisten", { cid: stream.cid, lid }).catch(() => {}); };
}
// pages that are hidden for a long time: the shell calls goOffline() (js/firebase.js), which closes the stream; goOnline() reopens it
addEventListener("online", () => stream.want && !stream.es && stream.start());

export const app = { initializeApp: () => ({ name: "private" }) };
export { authFn as auth, dbFn as db };
export const privateTools = { api, base: BASE, token: () => token };
