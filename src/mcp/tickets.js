import crypto from 'node:crypto';
import { db } from '../db.js';
import { recordNotification } from '../notifications.js';
import { configured as pushConfigured, sendPush, subscriptionsFor } from '../webpush.js';

// El registro de acciones propuestas por un agente de IA.
//
// El problema que resuelve: cuando el que llama es un modelo, "confirmación
// explícita" no puede ser un argumento booleano, porque el modelo puede escribir
// `confirm: true` solo. La confirmación tiene que viajar por un canal que el
// modelo no controla. Acá eso son dos fases:
//
//   1. propose_action crea un ticket y NO ejecuta nada. Para las acciones que
//      cambian matrícula real, mikampus genera un código de 6 dígitos, lo guarda
//      HASHEADO y lo manda por push al teléfono de Elias. El código nunca vuelve
//      por la respuesta MCP ni queda escrito en la base ni en el feed.
//   2. confirm_action solo ejecuta si el código coincide. Elias lo lee en la
//      notificación del teléfono y se lo dicta al agente.
//
// El teléfono es el canal justamente porque está fuera de esta máquina: un
// agente que corre acá puede leer archivos y la base, pero no la pantalla de
// bloqueo de un celular. Un canal local sería una barrera de mentira.
//
// El resumen del ticket lo redacta mikampus, no el modelo, y es el mismo texto
// que viaja en la push: lo que Elias lee no pasa por el modelo.
//
// Este módulo solo se carga cuando el servidor arranca con el carril de acción
// encendido, y es ahí donde entra la conexión de escritura de la app. El carril
// de lectura nunca lo importa, así que su conexión de solo lectura sigue siendo
// absoluta (scripts/test-mcp-isolation.mjs lo verifica sobre el grafo de
// imports).

// Tres minutos. La push llega en segundos, así que la ventana solo tiene que
// cubrir desbloquear el teléfono, leer seis dígitos y dictarlos. Corta a
// propósito: un código que alguien vio de reojo, o que quedó en la pantalla de
// bloqueo, deja de servir casi en el acto, y una propuesta que el agente hizo y
// nadie miró no se puede confirmar más tarde en otro contexto.
const TICKET_TTL_MS = 3 * 60_000;
const MAX_ATTEMPTS = 3;

const ENABLE_PUSH =
  'Abrí mikampus en el teléfono, entrá a Ajustes > Notificaciones y activá las notificaciones en ese dispositivo.';

// Un canal de confirmación caído no puede degradar a "confirmado": cuando no hay
// dónde entregar el código, la acción no se propone. Esta clase existe para que
// actions.js distinga ese caso de un error de ejecución.
export class NoConfirmationChannelError extends Error {
  constructor(reason) {
    super(`No hay canal de confirmación disponible, así que no se propuso nada. ${reason} ${ENABLE_PUSH}`);
    this.name = 'NoConfirmationChannelError';
  }
}

// La tabla la crea este módulo y no el esquema de src/db.js: los tickets no son
// dato académico, vencen solos en minutos y una base sin el carril de acción
// nunca los necesita.
db.exec(`
  CREATE TABLE IF NOT EXISTS mcp_action_tickets (
    id            TEXT PRIMARY KEY,
    user_id       INTEGER NOT NULL,
    kind          TEXT NOT NULL,
    payload       TEXT NOT NULL,
    summary       TEXT NOT NULL,
    effects       TEXT NOT NULL,
    code_hash     TEXT,
    attempts      INTEGER NOT NULL DEFAULT 0,
    reversible    INTEGER NOT NULL,
    state         TEXT NOT NULL DEFAULT 'pending',
    result        TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at    TEXT NOT NULL,
    resolved_at   TEXT
  );
`);

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// El audit log es el mismo que usa el resto de la app. Todo lo que pasa por el
// MCP se prefija con "mcp:" para que se pueda leer de dónde vino sin adivinar.
function log(action, detail, response, ok, { userId = 1, now = new Date() } = {}) {
  db
    .prepare(
      `INSERT INTO action_log (user_id, action, detail, portal_response, ok, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(userId, `mcp:${action}`, detail, String(response ?? ''), ok == null ? null : ok ? 1 : 0, now.toISOString());
}

// Qué hace cada acción, en una frase que lee una persona. La redacta mikampus
// para que el texto que Elias ve no dependa de cómo el modelo resuma el ticket.
export function describe(payload) {
  switch (payload.kind) {
    case 'sync':
      return {
        summary: `Leer del portal: ${payload.datasets.join(', ')}.`,
        effects: ['Abre el portal con tu cuenta', 'Actualiza datos locales', 'No cambia tu matrícula'],
        reversible: true,
      };
    case 'add_to_cart':
      return {
        summary: `Agregar al carrito la sección ${payload.classNbr} de ${payload.career} ${payload.courseNumber} en el ciclo ${payload.term}.`,
        effects: ['Modifica tu carrito en el portal', 'No te inscribe'],
        reversible: false,
      };
    case 'enroll_from_cart':
      return {
        summary: `Inscribir TODO lo que está en el carrito del ciclo ${payload.term}.`,
        effects: ['Cambia tu matrícula real en PeopleSoft', 'No se puede deshacer desde mikampus'],
        reversible: false,
      };
    case 'drop_class':
      return {
        summary: `Dar de baja ${payload.courseCode} del ciclo ${payload.term}.`,
        effects: ['Te saca de la materia en PeopleSoft', 'Recuperar el cupo depende de que siga abierto'],
        reversible: false,
      };
    default:
      throw new Error(`Acción desconocida: ${payload.kind}`);
  }
}

// Si el código no puede salir de esta máquina, no hay segunda barrera. Esto se
// consulta ANTES de generar nada para poder responder con el motivo real en vez
// de un "no se pudo entregar" genérico.
export function confirmationChannel({ userId = 1 } = {}) {
  if (process.env.MIKAMPUS_SILENT) {
    return { available: false, devices: 0, reason: 'Las notificaciones de mikampus están silenciadas (MIKAMPUS_SILENT).' };
  }
  if (!pushConfigured) {
    return {
      available: false,
      devices: 0,
      reason: 'Faltan las llaves VAPID (MIKAMPUS_VAPID_PUBLIC y MIKAMPUS_VAPID_PRIVATE) en el entorno del servidor.',
    };
  }
  const devices = subscriptionsFor(userId).length;
  if (devices === 0) {
    return { available: false, devices: 0, reason: 'Ningún dispositivo está suscrito a las notificaciones push.' };
  }
  return { available: true, devices, reason: null };
}

// La entrega. Devuelve por dónde salió el código; el código en sí no vuelve a
// ningún lado. Si la push no sale, esto lanza: sin entrega no hay ticket, y sin
// ticket no hay nada que confirmar.
async function deliverCode({ ticketId, code, summary, userId, expiresAt, now }) {
  const channel = confirmationChannel({ userId });
  if (!channel.available) {
    log('confirm-sin-canal', summary, channel.reason, false, { userId, now });
    throw new NoConfirmationChannelError(channel.reason);
  }

  // El código va en el título porque la pantalla de bloqueo muestra el título
  // primero: la idea es leerlo sin desbloquear nada. urgency critical le pide al
  // push service que no lo encole, que para un código de tres minutos es la
  // diferencia entre servir y no servir.
  const sent = await sendPush(userId, {
    title: `Código de mikampus: ${code}`,
    body: summary,
    url: '/',
    tag: `mcp-confirm:${ticketId}`,
    urgency: 'critical',
  });
  if (sent === 0) {
    const reason = 'Ningún dispositivo aceptó la notificación push.';
    log('confirm-sin-canal', summary, reason, false, { userId, now });
    throw new NoConfirmationChannelError(reason);
  }

  // El feed local deja el rastro de que se pidió una confirmación, SIN el
  // código: sirve para entender qué pasó cuando la push no llegó, y no convierte
  // la base en una segunda copia del secreto.
  recordNotification(
    {
      key: `mcp-confirm:${ticketId}`,
      title: 'Un agente propuso una acción sobre tu matrícula',
      body: `${summary} El código de confirmación salió por push y vence ${expiresAt}.`,
      urgency: 'critical',
      link: '/ajustes',
    },
    { userId, now }
  );

  return [`push a ${sent} dispositivo(s)`];
}

export async function createTicket(payload, { userId = 1, now = new Date() } = {}) {
  const { summary, effects, reversible } = describe(payload);
  const id = `mcp-${crypto.randomBytes(6).toString('hex')}`;
  const expiresAt = new Date(now.getTime() + TICKET_TTL_MS).toISOString();

  // Solo lo irreversible exige código. Un sync no cambia matrícula: su barrera
  // es que el agente tenga que llamar confirm_action a propósito.
  const code = reversible ? null : String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  // La entrega va PRIMERO: si falla, no queda un ticket pendiente que alguien
  // pueda confirmar sin haber recibido nunca el código.
  const deliveredVia = code
    ? await deliverCode({ ticketId: id, code, summary, userId, expiresAt, now })
    : ['no hace falta: la acción no cambia tu matrícula'];

  db
    .prepare(
      `INSERT INTO mcp_action_tickets (id, user_id, kind, payload, summary, effects, code_hash, reversible, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      userId,
      payload.kind,
      JSON.stringify(payload),
      summary,
      JSON.stringify(effects),
      code ? sha256(code) : null,
      reversible ? 1 : 0,
      expiresAt,
      now.toISOString()
    );

  return {
    ticketId: id,
    kind: payload.kind,
    summary,
    effects,
    reversible,
    requiresCode: Boolean(code),
    deliveredVia,
    state: 'pending',
    createdAt: now.toISOString(),
    expiresAt,
  };
}

function row(ticketId) {
  return db.prepare('SELECT * FROM mcp_action_tickets WHERE id = ?').get(ticketId) ?? null;
}

export function readTicket(ticketId) {
  const found = row(ticketId);
  if (!found) return null;
  return {
    ticketId: found.id,
    kind: found.kind,
    summary: found.summary,
    effects: JSON.parse(found.effects),
    reversible: found.reversible === 1,
    requiresCode: Boolean(found.code_hash),
    deliveredVia: [],
    state: found.state,
    createdAt: found.created_at,
    expiresAt: found.expires_at,
  };
}

// Pendiente incluye lo autorizado: un ticket que se autorizó y cuya ejecución se
// cortó a la mitad tiene que seguir siendo visible, aunque ya no se pueda volver
// a confirmar.
export function listPending({ now = new Date() } = {}) {
  expireStale({ now });
  return db
    .prepare("SELECT id FROM mcp_action_tickets WHERE state IN ('pending', 'authorized') ORDER BY created_at")
    .all()
    .map((entry) => readTicket(entry.id));
}

export function expireStale({ now = new Date() } = {}) {
  return db
    .prepare("UPDATE mcp_action_tickets SET state = 'expired', resolved_at = ? WHERE state = 'pending' AND expires_at <= ?")
    .run(now.toISOString(), now.toISOString()).changes;
}

export function cancelTicket(ticketId, { now = new Date() } = {}) {
  const found = row(ticketId);
  if (!found) throw new Error(`No existe el ticket ${ticketId}`);
  if (found.state !== 'pending') throw new Error(`El ticket ${ticketId} ya está en estado ${found.state}`);
  db
    .prepare("UPDATE mcp_action_tickets SET state = 'cancelled', resolved_at = ? WHERE id = ?")
    .run(now.toISOString(), ticketId);
  return readTicket(ticketId);
}

// Verifica el ticket y devuelve su payload listo para ejecutar. No ejecuta: la
// ejecución vive en src/mcp/actions.js, que es el único que habla con el agente.
//
// Un ticket es de un SOLO uso: autorizar lo saca de 'pending' en el acto y borra
// el hash del código. Dos confirm_action seguidos con el mismo código no pueden
// dar de baja la misma materia dos veces.
export function authorize(ticketId, code, { now = new Date() } = {}) {
  expireStale({ now });
  const found = row(ticketId);
  if (!found) throw new Error(`No existe el ticket ${ticketId}`);
  if (found.state !== 'pending') throw new Error(`El ticket ${ticketId} ya está en estado ${found.state}`);

  if (found.code_hash) {
    const given = String(code ?? '').trim();
    if (!given) throw new Error('Esta acción cambia tu matrícula: hace falta el código de confirmación que mikampus te mandó al teléfono.');
    if (sha256(given) !== found.code_hash) {
      // Un intento fallido queda escrito: si el código se está adivinando, tiene
      // que verse en el mismo audit log donde se ve todo lo demás.
      const attempts = found.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        db
          .prepare("UPDATE mcp_action_tickets SET attempts = ?, code_hash = NULL, state = 'cancelled', resolved_at = ? WHERE id = ?")
          .run(attempts, now.toISOString(), ticketId);
        log('confirm-rechazado', found.summary, `código incorrecto ${attempts} veces: ticket cancelado`, false, {
          userId: found.user_id,
          now,
        });
        throw new Error(`Código incorrecto ${attempts} veces: el ticket ${ticketId} quedó cancelado.`);
      }
      db.prepare('UPDATE mcp_action_tickets SET attempts = ? WHERE id = ?').run(attempts, ticketId);
      log('confirm-rechazado', found.summary, `código incorrecto (intento ${attempts} de ${MAX_ATTEMPTS})`, false, {
        userId: found.user_id,
        now,
      });
      throw new Error(`Código incorrecto (intento ${attempts} de ${MAX_ATTEMPTS}).`);
    }
  }

  db
    .prepare("UPDATE mcp_action_tickets SET state = 'authorized', code_hash = NULL WHERE id = ?")
    .run(ticketId);

  return JSON.parse(found.payload);
}

// Estado terminal + su rastro en action_log.
export function settle(ticketId, { ok, result, userId = 1, now = new Date() } = {}) {
  const found = row(ticketId);
  if (!found) throw new Error(`No existe el ticket ${ticketId}`);
  db
    .prepare('UPDATE mcp_action_tickets SET state = ?, result = ?, resolved_at = ? WHERE id = ?')
    .run(ok ? 'executed' : 'failed', String(result ?? ''), now.toISOString(), ticketId);
  log(found.kind, found.summary, result, ok, { userId, now });
  return readTicket(ticketId);
}
