// FamilyHub Service Worker — Notificaciones Push

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Recibir notificación push
self.addEventListener('push', e => {
  let data = { title: 'FamilyHub', body: 'Tienes eventos hoy', url: '/' };
  try { data = e.data.json(); } catch(err) {}

  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: 'https://miguelatovic.github.io/family-hub/icon.png',
      badge: 'https://miguelatovic.github.io/family-hub/icon.png',
      vibrate: [200, 100, 200],
      tag: 'familyhub-daily',
      renotify: true,
      data: { url: data.url || '/' }
    })
  );
});

// Al pulsar la notificación, abrir la app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes('family-hub') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow('https://miguelatovic.github.io/family-hub/');
    })
  );
});
