// Service worker mínimo: cachea el shell de la app (HTML, JS, CSS, fuentes)
// para que abra al instante y sobreviva a un recargue sin red.
//
// LO QUE NO HACE, a propósito: cachear /api. La app ya tiene un cache — SQLite,
// del lado del server— y todo lo que sirve viaja con su syncedAt y su
// StalenessTag, que es lo que te deja saber si un dato es de hace un minuto o
// de hace una semana (principio #6: honestidad de estado). Un segundo cache
// acá, invisible y sin fecha, contestaría con datos viejos sin que la UI pueda
// enterarse: el horario diría "actualizado hace instantes" mostrando lo de
// ayer. Sin el server local no hay datos, y eso está bien: es más honesto que
// mentir con datos rancios.
const CACHE = 'mikampus-shell-v1';

// Los assets del build llevan hash en el nombre (index-DNukDLZs.js), así que un
// hit de cache es siempre el archivo correcto: cuando el build cambia, cambia
// el nombre y se pide de red. Por eso cache-first es seguro acá y no lo sería
// para el HTML.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // /api y el SSE nunca: son datos vivos, y el feed de eventos es un stream que
  // un cache rompería en silencio.
  if (url.pathname.startsWith('/api/')) return;

  // El HTML va network-first: es lo único sin hash, así que un cache-first te
  // dejaría con la app de la semana pasada hasta que el SW se actualice.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((res) => {
          // Solo respuestas propias y completas: cachear un 404 o un opaque
          // response deja basura pegada hasta el próximo cambio de versión.
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
    )
  );
});

// Al activar una versión nueva, los caches viejos se van: el shell entero se
// vuelve a bajar y no quedan assets huérfanos de builds anteriores.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
});

self.addEventListener('install', () => self.skipWaiting());

// ── Web Push (L4 §5.5) ──────────────────────────────────────────────────────
// El server manda un payload JSON cifrado ({title, body, url, tag}); acá se
// convierte en la notificación del sistema. tag agrupa: una push nueva con el
// mismo tag reemplaza a la anterior en vez de apilar cinco "apareció cupo".
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'mikampus', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'mikampus';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || title,
      // renotify hace vibrar/sonar aunque reemplace una del mismo tag: un cupo
      // nuevo tiene que interrumpir, no actualizar en silencio.
      renotify: Boolean(data.tag),
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/' },
    })
  );
});

// Tocar la notificación abre la app en el deep-link que trae (el swap de una
// sección, /inscripcion, etc.); si ya hay una pestaña de mikampus abierta, la
// enfoca en vez de abrir otra.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      const existing = clients[0];
      if (existing && 'focus' in existing) {
        existing.navigate(url);
        return existing.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
