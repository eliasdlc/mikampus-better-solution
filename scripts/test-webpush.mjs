// El canal de Web Push (src/webpush.js) contra una DB desechable y un transport
// inyectado: no toca red ni un push service real. Lo que se prueba es lo que
// puede romper en silencio — que un dispositivo re-suscribiéndose no duplique,
// que un endpoint muerto (410) se pode solo, y que el dedupe por usuario evite
// los 80 envíos por hora de un watcher que falla.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-push-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
// Un par VAPID válido para que setVapidDetails no rechace al importar; el envío
// real se sustituye por un transport de mentira, así que nada sale a la red.
process.env.MIKAMPUS_VAPID_PUBLIC =
  'BI9cBciA_aPNeIiVfiS5ME2LISio8Fl3fUrVbKenwAwKHRK-uD-514fBR_EgOcA7z-tQAJH95ujDiYNapR9aMy0';
process.env.MIKAMPUS_VAPID_PRIVATE = 'ib-xDkProwE2zytitoClJk329aP34JDI1-mYQU25SDI';
delete process.env.MIKAMPUS_SILENT; // el envío está gated por SILENT; acá queremos ejercerlo

const { db } = await import('../src/db.js');
const {
  configured,
  vapidPublicKey,
  saveSubscription,
  removeSubscription,
  subscriptionsFor,
  sendPush,
  dispatchPush,
  __setTransport,
  __resetDedupe,
} = await import('../src/webpush.js');

assert.equal(configured, true, 'con llaves VAPID el canal está configurado');
assert.equal(vapidPublicKey(), process.env.MIKAMPUS_VAPID_PUBLIC, 'la pública se expone tal cual');

// Transport de mentira: registra cada envío y puede simular un endpoint muerto.
const sent = [];
let goneEndpoint = null;
__setTransport(async (subscription, payload) => {
  if (subscription.endpoint === goneEndpoint) {
    const err = new Error('Gone');
    err.statusCode = 410;
    throw err;
  }
  sent.push({ endpoint: subscription.endpoint, payload });
});

const sub = (endpoint, p256dh = 'k', auth = 'a') => ({ endpoint, keys: { p256dh, auth } });

try {
  // ── Upsert por endpoint: el mismo teléfono no duplica; actualiza sus claves. ──
  saveSubscription(3, sub('https://push.example/aaa', 'clave1', 'auth1'), 'Firefox');
  saveSubscription(3, sub('https://push.example/aaa', 'clave2', 'auth2'), 'Firefox');
  assert.equal(subscriptionsFor(3).length, 1, 'el re-subscribe del mismo endpoint no duplica');
  assert.equal(subscriptionsFor(3)[0].p256dh, 'clave2', 'el upsert actualiza las claves');

  // Una suscripción incompleta se rechaza — no guarda una fila que no sirve.
  assert.throws(() => saveSubscription(3, { endpoint: 'x' }), /incompleta/);

  // ── Un cupo va a TODOS los dispositivos del usuario, y solo a los suyos. ──
  saveSubscription(3, sub('https://push.example/bbb'));
  saveSubscription(4, sub('https://push.example/ccc')); // otro usuario
  sent.length = 0;
  const n = await sendPush(3, { title: 'Cupo en ICC-301', urgency: 'critical' });
  assert.equal(n, 2, 'los dos dispositivos del usuario 3 reciben');
  assert.equal(sent.length, 2);
  assert.ok(!sent.some((s) => s.endpoint === 'https://push.example/ccc'), 'el dispositivo del usuario 4 no recibe');
  const payload = JSON.parse(sent[0].payload);
  assert.equal(payload.title, 'Cupo en ICC-301', 'el payload viaja como JSON para el service worker');

  // last_ok_at se sella tras un envío exitoso.
  assert.ok(
    db.prepare('SELECT last_ok_at FROM push_subscriptions WHERE endpoint = ?').get('https://push.example/aaa').last_ok_at,
    'un envío exitoso sella last_ok_at'
  );

  // ── Un endpoint muerto (410) se poda; los demás sobreviven. ──
  goneEndpoint = 'https://push.example/aaa';
  sent.length = 0;
  const n2 = await sendPush(3, { title: 'otra' });
  assert.equal(n2, 1, 'solo el endpoint vivo recibe');
  assert.equal(subscriptionsFor(3).length, 1, 'el endpoint 410 se poda solo');
  assert.equal(subscriptionsFor(3)[0].endpoint, 'https://push.example/bbb', 'sobrevive el vivo');
  goneEndpoint = null;

  // ── dispatchPush: dedupe por usuario, no global. ──
  __resetDedupe();
  saveSubscription(4, sub('https://push.example/ddd')); // el usuario 4 tiene un device
  sent.length = 0;
  const notice = { title: 'El watcher no pudo leer', body: 'timeout', urgency: 'critical', key: 'watcher-error' };
  const now = Date.now();
  dispatchPush(3, notice, {}, now);
  dispatchPush(3, notice, {}, now + 1000); // repetido dentro de la ventana → una sola vez
  dispatchPush(4, notice, {}, now + 1000); // otro usuario, misma key → sí sale
  await new Promise((r) => setTimeout(r, 20)); // dispatchPush es fire-and-forget
  const to3 = sent.filter((s) => s.endpoint === 'https://push.example/bbb').length;
  const to4 = sent.filter((s) => s.endpoint === 'https://push.example/ddd').length;
  assert.equal(to3, 1, 'la repetida al mismo usuario dentro de la ventana sale una vez');
  assert.equal(to4, 1, 'el dedupe es por usuario: otro usuario con la misma key sí recibe');

  // ── Gating: MIKAMPUS_SILENT apaga el envío sin tocar el almacén. ──
  process.env.MIKAMPUS_SILENT = '1';
  sent.length = 0;
  assert.equal(await sendPush(3, { title: 'silenciada' }), 0, 'SILENT no envía');
  assert.equal(sent.length, 0);
  delete process.env.MIKAMPUS_SILENT;

  // removeSubscription borra solo ese endpoint del usuario.
  removeSubscription(3, 'https://push.example/bbb');
  assert.equal(subscriptionsFor(3).length, 0);
  assert.equal(subscriptionsFor(4).length, 2, 'borrar un endpoint no toca los de otro usuario');
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ web push: upsert por dispositivo, poda de endpoints muertos, dedupe por usuario, gating por SILENT');
