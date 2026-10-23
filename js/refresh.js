// "Refresh site": makes the browser fetch the newest copy of every page, script and stylesheet, then reloads.
// A normal reload only re-checks the page itself; scripts and styles that were loaded earlier can stay in the browser's HTTP cache.
// So this re-downloads (cache: "reload") everything the app uses: what's already loaded in this tab and its frames, plus whatever those scripts import.
const SEEDS = ["index.html", "message.html", "account.html", "call.html", "style.css", "call.css", "js/themeboot.js", "manifest.json", "firebase-messaging-sw.js"];
const IMPORT = /(?:from\s*|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+\.js)["']/g;

function loadedUrls(win, out, depth = 0) {
  try { for (const e of win.performance.getEntriesByType("resource")) if (e.name.startsWith(location.origin)) out.add(e.name.split("#")[0]); } catch (_) { /* ignore */ }
  try { out.add(win.location.href.split("#")[0]); } catch (_) { /* ignore */ }
  if (depth < 3) for (let i = 0; i < win.frames.length; i++) { try { loadedUrls(win.frames[i], out, depth + 1); } catch (_) { /* cross-origin frame */ } }
}

/** @returns {Promise<number>} how many files were refreshed. */
export async function refreshSite({ unregister = false, onProgress = () => {} } = {}) {
  const todo = new Set(), done = new Set();
  loadedUrls(window.top || window, todo);
  for (const s of SEEDS) todo.add(new URL(s, location.href).href.split("?")[0]);
  let n = 0;
  while (todo.size && done.size < 400) {
    const batch = [...todo].slice(0, 8);
    batch.forEach(u => { todo.delete(u); done.add(u); });
    await Promise.all(batch.map(async u => {
      try {
        const r = await fetch(u, { cache: "reload", credentials: "same-origin" });
        if (!r.ok) return;
        n++; onProgress(n);
        if (/\.js(\?|$)/.test(u)) { const text = await r.text(); for (const m of text.matchAll(IMPORT)) { const next = new URL(m[1], u).href.split("?")[0]; if (!done.has(next)) todo.add(next); } }
      } catch (_) { /* offline or missing: skip */ }
    }));
  }
  try { if ("caches" in window) for (const k of await caches.keys()) await caches.delete(k); } catch (_) { /* ignore */ }
  try {
    if (navigator.serviceWorker) for (const r of await navigator.serviceWorker.getRegistrations()) { if (unregister) await r.unregister().catch(() => {}); else await r.update().catch(() => {}); }
  } catch (_) { /* ignore */ }
  return n;
}
