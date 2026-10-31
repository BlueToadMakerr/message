// The ONE copy of the Firebase SDK for the whole site (the free Realtime Database plan allows only 100 simultaneous connections,
// and every frame that loaded its own SDK used to open its own websocket).
// The top window (the shell) loads the real SDK and publishes it; every frame inside it re-exports the shell's copy, so the shell,
// the open chat, the call page and the chat inside the call all share a single database connection and a single sign-in.
// A frame that is opened on its own (no shell above it) simply loads the SDK itself.
const V = "https://www.gstatic.com/firebasejs/11.0.1/";
let host = null;
try { if (window.top !== window) host = window.top.__qmSdk || null; } catch (_) { host = null; }
import { PRIVATE } from "./mode.js";
// Private server mode (docs/SERVER-PRIVATE.md): the same functions, implemented against server/qm_server.py instead of Google's SDK.
const ns = host || (PRIVATE ? await import("./private/sdk-private.js") : {
  app: await import(V + "firebase-app.js"),
  auth: await import(V + "firebase-auth.js"),
  db: await import(V + "firebase-database.js")
});
if (!host) { try { window.__qmSdk = ns; } catch (_) { /* ignore */ } }

// Listeners a frame registers on the shared SDK must die with that frame (an unloaded frame used to take its listeners down with
// its own connection). onDisconnect actions are run when the frame goes away for the same reason.
const subs = new Set(), disc = new Map();
const track = fn => host ? (...a) => { const u = fn(...a); if (typeof u !== "function") return u; subs.add(u); return () => { subs.delete(u); u(); }; } : fn;
if (host) {
  addEventListener("pagehide", () => {
    for (const u of [...subs]) { try { u(); } catch (_) { /* ignore */ } }
    subs.clear();
    for (const run of [...disc.values()]) { try { Promise.resolve(run()).catch(() => {}); } catch (_) { /* ignore */ } }
    disc.clear();
  });
}

export const initializeApp = ns.app.initializeApp;
export const EmailAuthProvider = ns.auth.EmailAuthProvider;
export const GoogleAuthProvider = ns.auth.GoogleAuthProvider;
export const createUserWithEmailAndPassword = ns.auth.createUserWithEmailAndPassword;
export const deleteUser = ns.auth.deleteUser;
export const getAuth = ns.auth.getAuth;
export const linkWithCredential = ns.auth.linkWithCredential;
export const linkWithPopup = ns.auth.linkWithPopup;
export const onAuthStateChanged = track(ns.auth.onAuthStateChanged);
export const onIdTokenChanged = track(ns.auth.onIdTokenChanged);
export const reauthenticateWithCredential = ns.auth.reauthenticateWithCredential;
export const reauthenticateWithPopup = ns.auth.reauthenticateWithPopup;
export const sendEmailVerification = ns.auth.sendEmailVerification;
export const sendPasswordResetEmail = ns.auth.sendPasswordResetEmail;
export const signInWithCredential = ns.auth.signInWithCredential;
export const signInWithEmailAndPassword = ns.auth.signInWithEmailAndPassword;
export const signInWithPopup = ns.auth.signInWithPopup;
export const signOut = ns.auth.signOut;
export const unlink = ns.auth.unlink;
export const updatePassword = ns.auth.updatePassword;
export const sendSignInLinkToEmail = ns.auth.sendSignInLinkToEmail;
export const updateProfile = ns.auth.updateProfile;
export const updateEmail = ns.auth.updateEmail;
export const reload = ns.auth.reload;
export const getIdToken = ns.auth.getIdToken;
export const setPersistence = ns.auth.setPersistence;
export const browserLocalPersistence = ns.auth.browserLocalPersistence;
export const indexedDBLocalPersistence = ns.auth.indexedDBLocalPersistence;
export const endBefore = ns.db.endBefore;
export const get = ns.db.get;
export const getDatabase = ns.db.getDatabase;
export const goOffline = ns.db.goOffline;
export const goOnline = ns.db.goOnline;
export const limitToLast = ns.db.limitToLast;
export const limitToFirst = ns.db.limitToFirst;
export const endAt = ns.db.endAt;
export const startAt = ns.db.startAt;
export const startAfter = ns.db.startAfter;
export const equalTo = ns.db.equalTo;
export const orderByChild = ns.db.orderByChild;
export const orderByKey = ns.db.orderByKey;
export const orderByValue = ns.db.orderByValue;
export const off = ns.db.off;
export const push = ns.db.push;
export const query = ns.db.query;
export const ref = ns.db.ref;
export const remove = ns.db.remove;
export const serverTimestamp = ns.db.serverTimestamp;
export const set = ns.db.set;
export const update = ns.db.update;
export const runTransaction = ns.db.runTransaction;
export const child = ns.db.child;
export const onValue = track(ns.db.onValue);
export const onChildAdded = track(ns.db.onChildAdded);
export const onChildChanged = track(ns.db.onChildChanged);
export const onChildRemoved = track(ns.db.onChildRemoved);
export const onChildMoved = track(ns.db.onChildMoved);
export const onDisconnect = host ? r => {
  const o = ns.db.onDisconnect(r), key = r.toString();
  return new Proxy(o, { get(t, k) {
    if (k === "remove") return () => { disc.set("r" + key, () => ns.db.remove(r)); return t.remove(); };
    if (k === "set") return v => { disc.set("s" + key, () => ns.db.set(r, v)); return t.set(v); };
    if (k === "cancel") return () => { disc.delete("r" + key); disc.delete("s" + key); return t.cancel(); };
    const v = t[k]; return typeof v === "function" ? v.bind(t) : v;
  } });
} : ns.db.onDisconnect;
