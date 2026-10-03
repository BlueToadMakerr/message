// Firebase Messaging service worker for QuickMessage.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  const notif = data.notification || {};
  const extra = data.data || {};
  const isCall = extra.call === '1';
  const title = notif.title || (isCall ? 'Incoming call' : 'New message');
  const body = notif.body || '';
  const chatId = extra.chatId || '';
  const link = extra.link || (data.fcm_options && data.fcm_options.link) || './index.html';
  const tag = notif.tag || (isCall && chatId ? 'call_' + chatId : chatId ? 'chat_' + chatId : 'qm_notification');

  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const viewingCall = wins.some(c => c.visibilityState === 'visible' && c.focused && isCall && chatId && c.url.includes('call.html?chatId=' + chatId));
    if (viewingCall) return;
    const existing = await self.registration.getNotifications({ tag });
    existing.forEach(n => n.close());
    await self.registration.showNotification(title, {
      body, data: { link, chatId, sessionId: extra.sessionId || '' },
      icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
      vibrate: [150, 75, 150], tag, renotify: true, requireInteraction: isCall
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
    for (const client of wins) {
      if ('navigate' in client && 'focus' in client && client.url.startsWith(self.registration.scope)) {
        await client.navigate(targetUrl);
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
  })());
});
