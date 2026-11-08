// Photos, clips and voice notes are stored apart from the message (…/media/{key}) so opening a chat only downloads the small message
// records; each one is fetched when it scrolls into view and then kept on this device (Cache Storage), so the database never sends it twice.
//  - The cache has a size limit (Account → Stored media); the least recently used entries go first.
//  - An entry is removed when its message is deleted (see cacheDrop / cachePrune), and when a chat is removed (cacheDropChat).
//  - The browser is asked to keep the storage ("persistent"), and if the disk is full the cache makes room for itself instead of failing.
const NAME = "qm-media-v1", LIMIT_KEY = "qm-media-mb";
export const LIMITS = [25, 100, 200, 500, 1000];                       // MB
export const DEFAULT_MB = 200;
const url = (chat, key) => `https://qm.invalid/${encodeURIComponent(chat)}/${encodeURIComponent(key)}`;
const parse = u => { const p = u.replace("https://qm.invalid/", "").split("/"); return [decodeURIComponent(p[0] || ""), decodeURIComponent(p[1] || "")]; };
let cacheP = null;
const open = () => cacheP ||= (typeof caches !== "undefined" ? caches.open(NAME) : Promise.reject(new Error("no cache"))).catch(() => null);

export function getLimitMb() { let n = DEFAULT_MB; try { n = +localStorage.getItem(LIMIT_KEY) || DEFAULT_MB; } catch (_) { /* ignore */ } return LIMITS.includes(n) ? n : DEFAULT_MB; }
export function setLimitMb(n) { try { localStorage.setItem(LIMIT_KEY, String(n)); } catch (_) { /* ignore */ } trim().catch(() => {}); }
async function limitBytes() {
  let b = getLimitMb() * 1048576;
  try { const e = navigator.storage && navigator.storage.estimate && await navigator.storage.estimate(); if (e && e.quota) b = Math.min(b, e.quota * 0.6); } catch (_) { /* ignore */ }
  return b;
}

// size + last use of every entry, built once per page from the entries' own headers
let idx = null;
async function index() {
  if (idx) return idx;
  const c = await open(); idx = new Map(); if (!c) return idx;
  const keys = await c.keys();
  for (let i = 0; i < keys.length; i += 16) await Promise.all(keys.slice(i, i + 16).map(async rq => {
    const r = await c.match(rq); if (!r) return;
    let size = +r.headers.get("x-qm-size"), ts = +r.headers.get("x-qm-ts") || 0;
    if (!size) { try { size = (await r.clone().text()).length; } catch (_) { size = 0; } }
    idx.set(rq.url, { size, ts });
  }));
  return idx;
}
const total = m => { let n = 0; for (const v of m.values()) n += v.size; return n; };

async function trim(extra = 0) {
  const c = await open(); if (!c) return;
  const m = await index(), max = await limitBytes();
  let sum = total(m) + extra;
  if (sum <= max) return;
  for (const [u] of [...m.entries()].sort((a, b) => a[1].ts - b[1].ts)) {          // least recently used first
    if (sum <= max) break;
    sum -= m.get(u).size; m.delete(u); await c.delete(u);
  }
}

export async function cacheGet(chat, key) {
  try {
    const c = await open(); if (!c) return null;
    const r = await c.match(url(chat, key)); if (!r) return null;
    if (idx && idx.has(url(chat, key))) idx.get(url(chat, key)).ts = Date.now();
    return await r.text();
  } catch (_) { return null; }
}
let askedPersist = false;
export async function cachePut(chat, key, text) {
  try {
    const c = await open(); if (!c) return;
    if (!askedPersist) { askedPersist = true; try { navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted()) && navigator.storage.persist(); } catch (_) { /* ignore */ } }
    const m = await index(), u = url(chat, key), size = text.length;
    if (size > (await limitBytes()) / 2) return;                                        // one huge file is not worth the whole cache
    await trim(size);
    const put = () => c.put(u, new Response(text, { headers: { "x-qm-size": String(size), "x-qm-ts": String(Date.now()) } }));
    try { await put(); }
    catch (_) {                                                                         // disk full: free up the older half and try once more
      const old = [...m.entries()].sort((a, b) => a[1].ts - b[1].ts); for (const [k] of old.slice(0, Math.ceil(old.length / 2))) { m.delete(k); await c.delete(k); }
      await put();
    }
    m.set(u, { size, ts: Date.now() });
  } catch (_) { /* storage unavailable: just no caching */ }
}
export async function cacheDrop(chat, key) { try { const c = await open(); if (!c) return; await c.delete(url(chat, key)); idx && idx.delete(url(chat, key)); } catch (_) { /* ignore */ } }
export async function cacheDropChat(chat) {
  try { const c = await open(); if (!c) return; const m = await index(); for (const u of [...m.keys()]) if (parse(u)[0] === chat) { m.delete(u); await c.delete(u); } } catch (_) { /* ignore */ }
}
/** Messages that were deleted while this device wasn't looking: cached entries of this chat, inside the part of the history that is loaded
 *  (keys at or after fromKey), whose message isn't there any more. */
export async function cachePrune(chat, fromKey, presentKeys) {
  try {
    const c = await open(); if (!c) return; const m = await index();
    for (const u of [...m.keys()]) { const [ch, k] = parse(u); if (ch === chat && k >= (fromKey || "") && !presentKeys.has(k)) { m.delete(u); await c.delete(u); } }
  } catch (_) { /* ignore */ }
}
export async function cacheStats() {
  try { const m = await index(); return { count: m.size, bytes: total(m), limit: getLimitMb() * 1048576 }; } catch (_) { return { count: 0, bytes: 0, limit: getLimitMb() * 1048576 }; }
}
export async function cacheClear() { try { await caches.delete(NAME); } catch (_) { /* ignore */ } cacheP = null; idx = null; }
export async function storageInfo() {
  const o = { persisted: null, quota: 0, usage: 0 };
  try { if (navigator.storage) { o.persisted = navigator.storage.persisted ? await navigator.storage.persisted() : null; const e = navigator.storage.estimate ? await navigator.storage.estimate() : null; if (e) { o.quota = e.quota || 0; o.usage = e.usage || 0; } } } catch (_) { /* ignore */ }
  return o;
}
