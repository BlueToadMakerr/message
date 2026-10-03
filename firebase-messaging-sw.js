// firebase-messaging-sw.js — shows chat notifications and focuses/opens the chat when clicked.

self.addEventListener('install', () => self.skipWaiting());
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
  const tag = notif.tag || (chatId ? 'chat_' + chatId : 'chat_notification');

  event.waitUntil((async () => {
    // Don't buzz the user if they're already looking at this very chat.
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const viewing = wins.some(c =>
      c.visibilityState === 'visible' && c.focused && chatId && c.url.includes('chatId=' + chatId));
    if (viewing) return;

    const existing = await self.registration.getNotifications({ tag });
    existing.forEach(n => n.close());
    await self.registration.showNotification(title, {
      body,
      data: { link },
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      vibrate: [100, 50, 100],
      tag,
      renotify: true,
      requireInteraction: false
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
      if ('navigate' in client && 'focus' in client && client.url.startsWith(self.registration.scope)) {
        await client.navigate(targetUrl);
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
  })());
});
