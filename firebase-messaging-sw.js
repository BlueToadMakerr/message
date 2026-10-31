// firebase-messaging-sw.js — shows chat notifications and focuses/opens the chat when clicked.

const OFFLINE_CACHE = 'qm-offline-v1';
const OFFLINE_URL = 'offline.html';
self.addEventListener('install', event => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then(c => c.add(new Request(OFFLINE_URL, { cache: 'reload' }))).catch(() => {}).then(() => self.skipWaiting()));
});
// A page that can't load (no connection) gets the offline page instead of the browser's error.
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.mode !== 'navigate') return;
  event.respondWith(fetch(req).catch(async () => {
    const hit = await caches.match(OFFLINE_URL);
    if (!hit) return Response.error();
    const body = await hit.text();
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }));
});
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

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
