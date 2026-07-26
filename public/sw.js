/* cloud-copilot service worker.
 *
 * Deliberately does NOT cache anything: this app talks to a local server and a
 * stale app shell would be far worse than a slow first paint. The worker exists
 * for exactly two reasons:
 *
 *   1. iOS Safari (16.4+) only exposes the Notification API to sites installed
 *      to the Home Screen, and only lets them be shown via
 *      `registration.showNotification()` — a ServiceWorkerRegistration is
 *      therefore mandatory to notify at all on iPhone.
 *   2. It gives notifications a click target that focuses/opens the app.
 */

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) {
        try {
          if (target && target !== '/' && 'navigate' in client) await client.navigate(target);
        } catch { /* cross-origin or blocked — just focus */ }
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
    return undefined;
  })());
});
