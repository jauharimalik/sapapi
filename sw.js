// sw.js - Service Worker untuk push notifications
self.addEventListener('push', function(event) {
    if (!event.data) return;
    
    const data = event.data.json();
    const options = {
        body: data.body,
        icon: data.icon || '/favicon.ico',
        badge: '/favicon.ico',
        tag: data.tag,
        data: data.data
    };
    
    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({type: 'window'}).then(function(clientList) {
            for (let client of clientList) {
                if (client.url.includes('/') && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow('/');
            }
        })
    );
});