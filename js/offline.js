// Offline data. Chats, the first page of messages, profiles and a few settings are kept on this device (IndexedDB) so they show at once
// on a slow or missing connection. The live data is always fetched too: when it arrives it replaces what was shown, and the
// "Updating…" pill (js/syncstatus.js) is on screen until then. Everything is removed when you sign out; Account → Data & storage controls it.
import { get, onValue } from "./sdk.js";
import { begin } from "./syncstatus.js";
export { begin };

const DB = "qm-offline", ST = "kv", MAX_BYTES = 30e6, MAX_ENTRY = 800000;
export const offlineOn = () => { try { return localStorage.getItem("qm-offline") !== "off"; } catch (_) { return true; } };
export const setOfflineOn = on => { try { localStorage.setItem("qm-offline", on ? "on" : "off"); } catch (_) { /* ignore */ } if (!on) ocClear(); };

let dbp = null;
const open = () => dbp ||= new Promise(res => {
  try { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(ST); r.onsuccess = () => res(r.result); r.onerror = r.onblocked = () => res(null); } catch (_) { res(null); }
});
const run = async (mode, f) => { const db = await open(); if (!db) return undefined; return new Promise(res => { try { const tx = db.transaction(ST, mode), st = tx.objectStore(ST); let out; const rq = f(st); if (rq) rq.onsuccess = () => { out = rq.result; }; tx.oncomplete = () => res(out); tx.onerror = tx.onabort = () => res(undefined); } catch (_) { res(undefined); } }); };

/** { v, ts } or undefined */
export const ocGet = key => offlineOn() ? run("readonly", st => st.get(key)) : Promise.resolve(undefined);
let sets = 0;
export async function ocSet(key, v) {
  if (!offlineOn()) return;
  let n = 0; try { n = JSON.stringify(v).length; } catch (_) { return; }
  if (n > MAX_ENTRY) return;
  await run("readwrite", st => st.put({ v, ts: Date.now(), n }, key));
  if (++sets % 25 === 0) trim().catch(() => {});
}
export const ocDel = key => run("readwrite", st => st.delete(key));
export const ocClear = () => run("readwrite", st => st.clear());
async function all() {
  const db = await open(); if (!db) return [];
  return new Promise(res => { const out = []; try { const rq = db.transaction(ST).objectStore(ST).openCursor(); rq.onsuccess = () => { const c = rq.result; if (c) { out.push([c.key, c.value.ts || 0, c.value.n || 0]); c.continue(); } else res(out); }; rq.onerror = () => res(out); } catch (_) { res(out); } });
}
export async function ocStats() { const a = await all(); return { count: a.length, bytes: a.reduce((s, x) => s + x[2], 0) }; }
async function trim() {
  const a = (await all()).filter(x => !x[0].startsWith("meta:")).sort((x, y) => x[1] - y[1]); let sum = a.reduce((s, x) => s + x[2], 0);
  for (const [k, , n] of a) { if (sum <= MAX_BYTES) break; sum -= n; await ocDel(k); }       // oldest first
}
/** Called with the signed-in uid (or null on sign-out): nothing from another account is ever shown. */
export async function ocAccount(uid) {
  const cur = await run("readonly", st => st.get("meta:uid"));
  if (!uid) { await ocClear(); return; }
  if (cur && cur.v !== uid) await ocClear();
  if (!cur || cur.v !== uid) await run("readwrite", st => st.put({ v: uid, ts: Date.now(), n: 0 }, "meta:uid"));
}

// ---- snapshots made from saved data
const clone = v => { try { return v == null ? v : structuredClone(v); } catch (_) { return v; } };
export class SavedSnap {
  constructor(ref, key, val, items) { this.ref = ref; this.key = key; this._v = val; this._items = items; this.fromCache = true; }
  val() { return clone(this._v); }
  exists() { return this._v != null; }
  hasChildren() { return this._v != null && typeof this._v === "object" && Object.keys(this._v).length > 0; }
  get size() { return this._items ? this._items.length : this._v && typeof this._v === "object" ? Object.keys(this._v).length : 0; }
  exportVal() { return this.val(); }
  toJSON() { return this.val(); }
  child(p) { let v = this._v; for (const k of String(p).split("/")) { v = v && typeof v === "object" ? v[k] : undefined; } return new SavedSnap(null, String(p).split("/").pop(), v === undefined ? null : v); }
  forEach(cb) {
    const items = this._items || (this._v && typeof this._v === "object" ? Object.entries(this._v) : []);
    for (const [k, v] of items) if (cb(new SavedSnap(null, k, v)) === true) return true;
    return false;
  }
}
export const savedPage = (items) => new SavedSnap(null, null, Object.fromEntries(items), items);

function pathOf(r) {
  try {
    let p = typeof r.path === "string" ? r.path : decodeURIComponent(new URL(r.toString()).pathname.replace(/^\//, ""));
    return p && !p.startsWith(".info") ? p : null;
  } catch (_) { return null; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** get(), but a saved copy is used when the live answer is slow (1.5 s) or can't arrive; the live answer still updates the saved copy. Only for reads that are shown, never for read-then-write logic. */
export async function getSWR(r, staleMs = 1000) {
  const path = pathOf(r), hit = path && offlineOn() ? await ocGet("v:" + path).catch(() => undefined) : undefined;
  const real = get(r).then(s => { if (path && offlineOn()) { s.exists() ? ocSet("v:" + path, s.val()) : ocDel("v:" + path); } return s; });
  if (!hit || hit.v == null) return real;
  return new Promise(res => {
    let done = false, end = null;
    const fin = v => { if (!done) { done = true; res(v); } };
    const stale = () => { if (done) return; end = begin("get"); real.then(() => end && end(), () => end && end()); fin(new SavedSnap(r, r.key, hit.v)); };
    const t = setTimeout(stale, staleMs);
    real.then(s => { clearTimeout(t); fin(s); }, () => { clearTimeout(t); stale(); });
  });
}

/** onValue(), but the saved copy is delivered first (marked snap.fromCache) until the live value arrives. */
export function onValueSWR(r, cb, err) {
  const path = pathOf(r); let live = false, dead = false, end = null;
  if (path && offlineOn()) ocGet("v:" + path).then(hit => {
    if (!hit || hit.v == null || live || dead) return;
    end = begin("watch"); try { cb(new SavedSnap(r, r.key, hit.v)); } catch (e) { console.error(e); }
  }).catch(() => {});
  const un = onValue(r, snap => {
    live = true; if (end) { end(); end = null; }
    if (path && offlineOn()) { snap.exists() ? ocSet("v:" + path, snap.val()) : ocDel("v:" + path); }
    cb(snap);
  }, e => { live = true; if (end) { end(); end = null; } err && err(e); });
  return () => { dead = true; if (end) { end(); end = null; } un(); };
}
export { sleep };
