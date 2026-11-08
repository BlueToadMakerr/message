// firebase-messaging-sw.js — shows chat notifications, opens/focuses the chat when clicked, and keeps a saved copy of the site.
//
// Saved copy of the site (so a bad site update can't lock you out):
//   qm-site-cur       the newest copy of every page / script / style that was loaded (network first, this is the fallback when offline or the host errors)
//   qm-good-<ver>     the "last working copy": saved by the app after a whole session started fine (see js/sitecopy.js)
//   Safe mode         serves ONLY the last working copy. Turn it on from Account → Saved copy, from the "page didn't load" box,
//                     or by opening  index.html?safe=1  (and  ?safe=0  to go back to the live site).
//   Data Saver        while it is on, saved files are used without asking the host for newer ones (Account → Refresh site fetches fresh ones).

const OFFLINE_CACHE = 'qm-offline-v1';
const OFFLINE_URL = 'offline.html';
const CUR = 'qm-site-cur', GOOD = 'qm-good-', META = 'qm-site-meta';
const CFG_URL = self.registration.scope + '__qm_cfg';
const FETCH_MS = 12000;

let cfg = null;                                                    // { safe, saver, goodVersion, goodAt, goodCount }
async function loadCfg() {
  if (cfg) return cfg;
  try { const r = await (await caches.open(META)).match(CFG_URL); cfg = r ? await r.json() : {}; } catch (e) { cfg = {}; }
  return cfg;
}
async function saveCfg() { try { await (await caches.open(META)).put(CFG_URL, new Response(JSON.stringify(cfg))); } catch (e) { /* ignore */ } }
async function goodCache() { const k = (await caches.keys()).filter(n => n.startsWith(GOOD)).sort().pop(); return k ? caches.open(k) : null; }

// Only the app's own static files are kept; version checks, uploads, the database and the PHP helpers always go to the network.
function cacheable(url) {
  if (url.origin !== location.origin) return false;
  const p = url.pathname;
  if (/\.php$|version\.json$|\/api\/|\/downloads\//i.test(p) || p.endsWith('firebase-messaging-sw.js')) return false;
  return p.endsWith('/') || /\.(?:html|js|css|svg|png|webmanifest|json|woff2?)$/i.test(p);
}
const keyOf = url => url.origin + url.pathname;                    // the query (?chat=…, ?_r=…) doesn't change which file it is

async function looksFine(res, url) {
  if (!res.ok || res.type !== 'basic') return false;
  const type = res.headers.get('content-type') || '';
  const wantsHtml = /\.html$|\/$/i.test(url.pathname);
  if (/text\/html/i.test(type) && !wantsHtml) return false;        // a host "checking your browser" page where a script should be
  if (wantsHtml) { try { const t = await res.clone().text(); if (!/<\/html>/i.test(t) || /slowAES|aes\.js/.test(t)) return false; } catch (e) { return false; } }
  return true;
}
function timed(req) {
  return new Promise((ok, no) => { const t = setTimeout(() => no(new Error('timeout')), FETCH_MS); fetch(req).then(r => { clearTimeout(t); ok(r); }, e => { clearTimeout(t); no(e); }); });
}
async function offlinePage() {
  const hit = await caches.match(OFFLINE_URL);
  if (!hit) return Response.error();
  return new Response(await hit.text(), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
async function saved(key) {
  const hit = await (await caches.open(CUR)).match(key);
  if (hit) return hit;
  const g = await goodCache();
  return g ? g.match(key) : undefined;
}

async function handle(req, url) {
  const c = await loadCfg();
  const key = keyOf(url);
  if (req.mode === 'navigate' && url.searchParams.has('safe')) { c.safe = url.searchParams.get('safe') !== '0'; await saveCfg(); }
  if (c.safe) {                                                     // safe mode: the last working copy only (the live site for files it doesn't have)
    const g = await goodCache(), hit = g && await g.match(key);
    if (hit) return hit;
  }
  const forced = req.cache === 'reload' || req.cache === 'no-cache' || req.cache === 'no-store';      // a manual reload / Refresh site always asks the host
  if (c.saver && !c.safe && !forced) { const hit = await saved(key); if (hit) return hit; }       // Data Saver: no "is there something newer?" request
  const cur = await caches.open(CUR);
  try {
    const res = await timed(req);
    if (await looksFine(res, url)) { cur.put(key, res.clone()).catch(() => {}); return res; }
    if (!res.ok && res.status >= 500) { const hit = await saved(key); if (hit) return hit; }
    return res;
  } catch (e) {
    const hit = await saved(key);
    if (hit) return hit;
    if (req.mode === 'navigate') return offlinePage();
    throw e;
  }
}

self.addEventListener('install', event => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then(c => c.add(new Request(OFFLINE_URL, { cache: 'reload' }))).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (cacheable(url)) { event.respondWith(handle(req, url)); return; }
  if (req.mode === 'navigate') event.respondWith(fetch(req).catch(offlinePage));
});
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// Messages from the app (js/sitecopy.js, js/datasaver.js): { op: 'saver'|'safe'|'promote'|'status'|'forget' } — answers go through the port when there is one.
self.addEventListener('message', event => {
  const m = event.data || {};
  if (!m.op) return;
  const reply = v => { try { event.ports && event.ports[0] && event.ports[0].postMessage(v); } catch (e) { /* ignore */ } };
  event.waitUntil((async () => {
    const c = await loadCfg();
    if (m.op === 'saver') { c.saver = !!m.on; await saveCfg(); return reply({ ok: true }); }
    if (m.op === 'safe') { c.safe = !!m.on; await saveCfg(); return reply({ ok: true, safe: c.safe }); }
    if (m.op === 'status') { const g = await goodCache(); return reply({ ok: true, safe: !!c.safe, saver: !!c.saver, has: !!g, version: c.goodVersion || '', at: c.goodAt || 0, count: c.goodCount || 0 }); }
    if (m.op === 'forget') { for (const n of await caches.keys()) if (n.startsWith(GOOD) || n === CUR) await caches.delete(n); c.goodVersion = ''; c.goodAt = 0; c.goodCount = 0; c.safe = false; await saveCfg(); return reply({ ok: true }); }
    if (m.op === 'promote') {
      // Everything this session loaded becomes the last working copy (taken from the newest copy; missing ones are fetched unless Data Saver is on)
      const name = GOOD + String(Date.now()), good = await caches.open(name), cur = await caches.open(CUR);
      const urls = [...new Set((m.urls || []).map(u => { try { return new URL(u, self.registration.scope); } catch (e) { return null; } }).filter(u => u && cacheable(u)).map(keyOf))].slice(0, 400);
      let n = 0;
      for (const key of urls) {
        try {
          let r = await cur.match(key);
          if (!r && !m.noFetch) { const f = await timed(new Request(key, { cache: 'reload' })); if (await looksFine(f, new URL(key))) r = f; }
          if (r) { await good.put(key, r.clone()); n++; }
        } catch (e) { /* skip this file */ }
      }
      if (n < 5) { await caches.delete(name); return reply({ ok: false, count: n }); }       // not a real copy: keep the old one
      for (const k of await caches.keys()) if (k.startsWith(GOOD) && k !== name) await caches.delete(k);
      c.goodVersion = String(m.version || ''); c.goodAt = Date.now(); c.goodCount = n; await saveCfg();
      return reply({ ok: true, count: n });
    }
  })());
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { /* non-JSON payload */ }

  const notif = data.notification || {};
  const extra = data.data || {};
  const title = notif.title || 'New message';
  const body = notif.body || '';
  const chatId = extra.chatId || '';
  const link = extra.link || (data.fcm_options && data.fcm_options.link) || './index.html';
  const tag = notif.tag || (extra.call === '1' ? 'call_' + chatId : chatId ? 'chat_' + chatId : 'chat_notification');

  event.waitUntil((async () => {
    // (both lookups at once: a push should reach the screen as quickly as possible)
    const [wins, existing] = await Promise.all([
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }),
      self.registration.getNotifications({ tag }).catch(() => [])
    ]);
    const isCall = extra.call === '1' || (notif.tag || '').startsWith('call_');
    // The app shell shows incoming calls full-screen itself, so a call push is only needed when no app window is
    // on screen. Chat pushes are muted while that very chat is open (shell URL: ?chat=<id>).
    const viewing = wins.some(c => c.visibilityState === 'visible' && c.focused &&
      (isCall ? c.url.startsWith(self.registration.scope) : (chatId && (c.url.includes('chat=' + chatId) || c.url.includes('chatId=' + chatId)))));
    if (viewing) return;

    // Several messages in a row stack up in ONE notification (the last few lines) instead of each one wiping the one before.
    // The new notification replaces the old one under the same tag, so there is no flicker of closing and reopening.
    let lines = [];
    if (!isCall) { const prev = existing[0] && existing[0].data && existing[0].data.lines; if (Array.isArray(prev)) lines = prev.slice(-4); }
    lines.push(body);
    await self.registration.showNotification(title, {
      body: lines.length > 1 ? lines.join('\n') : body,
      data: { link, lines: isCall ? [] : lines },
      icon: 'icons/icon-192.png',
      ...(extra.image && /^https:\/\//.test(extra.image) && !isCall ? { image: extra.image } : {}),       // a photo is shown big (Chrome / Edge / Android; Safari and Firefox ignore it)
      badge: 'icons/icon-192.png',
      vibrate: extra.call === '1' ? [300, 150, 300, 150, 300] : [100, 50, 100],
      tag,
      renotify: true,
      requireInteraction: extra.call === '1'
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = new URL((event.notification.data && event.notification.data.link) || './index.html', self.location.href).href;

  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of wins) {
      if (client.url === targetUrl && 'focus' in client) return client.focus();
    }
    // Reuse an open app tab if there is one, otherwise open a new window.
    for (const client of wins) {
      if ('focus' in client && client.url.startsWith(self.registration.scope)) {
        // Don't reload the app (that would drop a running call) — let it switch chats itself.
        client.postMessage({ qm: 'open', link: targetUrl });
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
  })());
});
