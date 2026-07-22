// Notificaciones durables: dedupe que sobrevive a un reinicio, deep-link por
// evento, y adaptadores externos apagados con destino y payload declarados.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-notify-'));
process.env.MIKAMPUS_DATA_DIR = dir;
process.env.MIKAMPUS_DB = path.join(dir, 'mikampus.db');
process.env.MIKAMPUS_SILENT = '1';

const { noticeFor, notifyFromEvent, deepLink } = await import('../src/notify.js');
const { readFeed, shouldSend, unreadCount, markFeedRead } = await import('../src/notifications.js');
const channels = await import('../src/channels.js');

try {
  // ── Deep-link: cada aviso sabe a qué pantalla lleva ──────────────────────
  assert.equal(noticeFor({ type: 'enroll-result', results: [{ success: true, classLabel: 'ICC-303' }] }).link, '/horario');
  assert.equal(
    noticeFor({ type: 'enroll-result', reason: 'cupo detectado', results: [{ success: false, classLabel: 'ICC-303', message: 'lleno' }] }).link,
    '/inscripcion'
  );
  assert.equal(noticeFor({ type: 'notice', title: 'x', link: '/academico' }).link, '/academico');
  process.env.PORT = '4173';
  assert.equal(deepLink('/horario'), 'http://127.0.0.1:4173/horario', 'el deep-link apunta al agente local');
  assert.equal(deepLink(null), null);

  // ── Dedupe durable: se guarda en la base, no en un Map del proceso ───────
  const t0 = Date.parse('2026-07-20T10:00:00Z');
  const first = notifyFromEvent({ type: 'notice', level: 'error', title: 'El portal no responde', key: 'watcher-fail' }, t0);
  assert.ok(first, 'el primer aviso se emite');
  assert.equal(
    notifyFromEvent({ type: 'notice', level: 'error', title: 'El portal no responde', key: 'watcher-fail' }, t0 + 60_000),
    null,
    'el mismo aviso dentro de la ventana no vuelve a interrumpir'
  );
  assert.equal(shouldSend('watcher-fail', t0 + 6 * 60_000), true, 'pasada la ventana vuelve a poder emitirse');
  assert.equal(readFeed(1).length, 1, 'el feed registra el aviso una sola vez');

  // Reiniciar el agente no puede repetir el mismo popup: el estado vive en la
  // base, así que un módulo recién importado ve el mismo dedupe.
  const reimported = await import(`../src/notifications.js?reboot=${Date.now()}`);
  assert.equal(reimported.shouldSend('watcher-fail', t0 + 60_000), false, 'el dedupe sobrevive a un reinicio del agente');

  assert.equal(unreadCount(1), 1);
  markFeedRead(1);
  assert.equal(unreadCount(1), 0, 'el feed se puede marcar como leído');

  // ── Navegador cerrado: el aviso no depende de que haya un SSE escuchando ─
  // El SSE es el feed en vivo, no el transporte de la notificación. Con cero
  // listeners —que es exactamente "cerraste la pestaña"— el evento igual pasa
  // por la política y queda registrado para el transporte nativo.
  const scheduler = await import('../src/scheduler.js');
  scheduler.emitEvent({
    type: 'enroll-result',
    userId: 1,
    reason: 'cupo detectado',
    results: [{ success: true, classLabel: 'ICC-303' }],
  });
  const feed = readFeed(1);
  assert.equal(feed[0].title, '¡Inscrito!', 'sin ningún cliente conectado, la notificación se produce igual');
  assert.equal(feed[0].link, '/horario', 'y conserva su deep-link');

  // ── Adaptadores externos: apagados, declarados y probables ───────────────
  assert.deepEqual(channels.listChannels(), [], 'no hay ningún adaptador externo por defecto');
  const id = channels.saveChannel({ kind: 'webhook', destination: 'https://ejemplo.invalid/hook' });
  const [channel] = channels.listChannels();
  assert.equal(channel.enabled, false, 'un adaptador nace apagado');
  assert.equal(channel.external, true);
  assert.ok(channel.dependency, 'declara de qué depende antes de encenderse');
  assert.deepEqual(Object.keys(channel.payloadSample).sort(), ['body', 'link', 'title', 'urgency'], 'el payload declarado es mínimo');

  assert.throws(() => channels.saveChannel({ kind: 'webhook', destination: 'no-es-una-url' }), /URL/, 'rechaza destinos inválidos');
  assert.throws(() => channels.saveChannel({ kind: 'telegram', destination: 'https://x.invalid' }), /desconocido/);

  // Sin canales encendidos no sale un solo request.
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true };
  };
  await channels.dispatchToChannels({ title: 'x', body: 'y', key: 'k' }, { fetchImpl });
  assert.equal(calls, 0, 'un adaptador apagado no genera tráfico');

  const failed = await channels.testChannel(id, { fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(failed.ok, false, 'el botón de prueba reporta el fallo real');
  assert.match(channels.listChannels()[0].lastError, /500/, 'el error queda visible en la UI');

  channels.setChannelEnabled(id, true);
  await channels.dispatchToChannels({ title: 'Apareció cupo', body: 'ICC-303', key: 'k', link: '/inscripcion' }, { fetchImpl });
  assert.equal(calls, 1, 'ya encendido, recibe el aviso');
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ notificaciones: dedupe durable, deep-link por evento y adaptadores externos opt-in');
