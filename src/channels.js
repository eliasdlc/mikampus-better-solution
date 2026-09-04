import { db } from './db.js';

// Adaptadores de notificación externos (Fase 4 §5). Home Server no tiene
// escritorio: su base es el feed local. Cualquier otra salida es tráfico que
// abandona el equipo del usuario, así que cada adaptador tiene que declarar
// tres cosas ANTES de encenderse — a dónde va, qué manda y de qué depende — y
// nace apagado. Es el contrato de egress hecho de datos y no de promesas.

// El payload es deliberadamente pobre: título, cuerpo corto y el enlace local.
// Nunca la credencial, nunca notas, nunca la materia con su class_nbr real.
export function payloadFor(notice) {
  return {
    title: notice.title,
    body: notice.body ?? '',
    urgency: notice.urgency ?? 'normal',
    // El deep-link es a localhost: fuera de la máquina no abre nada, y por eso
    // no revela nada de la cuenta.
    link: notice.link ?? null,
  };
}

export const ADAPTERS = {
  feed: {
    kind: 'feed',
    label: 'Feed local',
    external: false,
    dependency: null,
    describe: () => 'La base de datos local de esta instalación',
    async send() {
      // El feed ya se persistió en notifications.js: este adaptador existe para
      // que la UI muestre el transporte base junto a los demás.
      return { ok: true };
    },
  },
  ntfy: {
    kind: 'ntfy',
    label: 'ntfy (self-hosted o público)',
    external: true,
    dependency: 'Un servidor ntfy. Si usás ntfy.sh, el mensaje pasa por un servicio de terceros.',
    describe: (destination) => destination,
    async send(destination, notice, fetchImpl = fetch) {
      const payload = payloadFor(notice);
      const response = await fetchImpl(destination, {
        method: 'POST',
        headers: { Title: payload.title, Priority: payload.urgency === 'critical' ? 'urgent' : 'default' },
        body: payload.body || payload.title,
      });
      if (!response.ok) throw new Error(`ntfy respondió HTTP ${response.status}`);
      return { ok: true };
    },
  },
  webhook: {
    kind: 'webhook',
    label: 'Webhook HTTP',
    external: true,
    dependency: 'El servicio del otro extremo de esa URL; mikampus no controla qué hace con el payload.',
    describe: (destination) => destination,
    async send(destination, notice, fetchImpl = fetch) {
      const response = await fetchImpl(destination, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadFor(notice)),
      });
      if (!response.ok) throw new Error(`El webhook respondió HTTP ${response.status}`);
      return { ok: true };
    },
  },
};

function validate(kind, destination) {
  const adapter = ADAPTERS[kind];
  if (!adapter) throw new Error(`Adaptador desconocido: ${kind}`);
  if (adapter.external) {
    let url;
    try {
      url = new URL(destination);
    } catch {
      throw new Error('El destino tiene que ser una URL completa (https://…)');
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Solo se aceptan destinos HTTP o HTTPS');
  }
  return adapter;
}

export function listChannels() {
  const rows = db
    .prepare('SELECT id, kind, label, destination, enabled, last_test_at AS lastTestAt, last_error AS lastError FROM notification_channels ORDER BY id')
    .all();
  return rows.map((row) => {
    const adapter = ADAPTERS[row.kind];
    return {
      ...row,
      enabled: row.enabled === 1,
      external: adapter?.external ?? true,
      dependency: adapter?.dependency ?? 'Adaptador desconocido',
      payloadSample: payloadFor({ title: 'Apareció cupo en ICC-303', body: 'Sección 01 · 1 cupo', urgency: 'critical', link: '/inscripcion' }),
    };
  });
}

export function availableAdapters() {
  return Object.values(ADAPTERS).map(({ kind, label, external, dependency }) => ({ kind, label, external, dependency }));
}

// Alta explícita y apagada: crear el canal no lo activa. Encenderlo es un
// segundo gesto, después de haber visto el destino y probado el envío.
export function saveChannel({ kind, label, destination }) {
  const adapter = validate(kind, destination);
  const info = db
    .prepare('INSERT INTO notification_channels (kind, label, destination, enabled) VALUES (?, ?, ?, 0)')
    .run(kind, label?.trim() || adapter.label, destination);
  return Number(info.lastInsertRowid);
}

export function setChannelEnabled(id, enabled) {
  const row = db.prepare('SELECT kind, destination FROM notification_channels WHERE id = ?').get(id);
  if (!row) throw new Error('Ese canal de notificación no existe');
  validate(row.kind, row.destination);
  db.prepare('UPDATE notification_channels SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  return Boolean(enabled);
}

export function deleteChannel(id) {
  db.prepare('DELETE FROM notification_channels WHERE id = ?').run(id);
}

export async function testChannel(id, { fetchImpl = fetch, now = new Date() } = {}) {
  const row = db.prepare('SELECT id, kind, destination FROM notification_channels WHERE id = ?').get(id);
  if (!row) throw new Error('Ese canal de notificación no existe');
  const adapter = validate(row.kind, row.destination);
  const notice = { title: 'Prueba de mikampus', body: 'Si ves esto, el canal funciona.', urgency: 'normal', link: '/ajustes' };
  try {
    await adapter.send(row.destination, notice, fetchImpl);
    db.prepare('UPDATE notification_channels SET last_test_at = ?, last_error = NULL WHERE id = ?').run(now.toISOString(), id);
    return { ok: true };
  } catch (error) {
    db.prepare('UPDATE notification_channels SET last_test_at = ?, last_error = ? WHERE id = ?').run(now.toISOString(), error.message, id);
    return { ok: false, error: error.message };
  }
}

// Solo los canales encendidos reciben tráfico real. Un fallo de un adaptador no
// puede tumbar la operación que lo originó: la notificación es el accesorio.
export async function dispatchToChannels(notice, { fetchImpl = fetch } = {}) {
  const enabled = db
    .prepare('SELECT id, kind, destination FROM notification_channels WHERE enabled = 1')
    .all();
  const results = [];
  for (const row of enabled) {
    const adapter = ADAPTERS[row.kind];
    if (!adapter) continue;
    try {
      await adapter.send(row.destination, notice, fetchImpl);
      results.push({ id: row.id, ok: true });
    } catch (error) {
      db.prepare('UPDATE notification_channels SET last_error = ? WHERE id = ?').run(error.message, row.id);
      results.push({ id: row.id, ok: false, error: error.message });
    }
  }
  return results;
}
