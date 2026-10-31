// Photos, clips and voice notes are stored apart from the message (privateChats/{chat}/media/{key}) so opening a chat only downloads the small
// message records; a picture is fetched when it scrolls into view, and kept on this device (Cache Storage) so it is never downloaded twice.
const NAME = "qm-media-v1", MAX = 150;
const url = (chat, key) => `https://qm.invalid/${chat}/${key}`;
let cacheP = null;
const open = () => cacheP ||= (typeof caches !== "undefined" ? caches.open(NAME) : Promise.reject(new Error("no cache"))).catch(() => null);

export async function cacheGet(chat, key) {
  try { const c = await open(); if (!c) return null; const r = await c.match(url(chat, key)); return r ? await r.text() : null; } catch (_) { return null; }
}
export async function cachePut(chat, key, text) {
  try {
    const c = await open(); if (!c) return;
    await c.put(url(chat, key), new Response(text));
    const keys = await c.keys();
    for (let i = 0; i < keys.length - MAX; i++) await c.delete(keys[i]);          // oldest first
  } catch (_) { /* storage full or unavailable: just no caching */ }
}
export async function cacheDrop(chat, key) { try { const c = await open(); c && await c.delete(url(chat, key)); } catch (_) { /* ignore */ } }
