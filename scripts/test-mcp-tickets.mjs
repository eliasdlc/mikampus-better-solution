// El carril de acción del MCP: nada se ejecuta sin una confirmación que viaje
// por un canal que el agente de IA no controla. Ese canal es la push al
// teléfono, así que lo que se prueba acá es lo que lo puede volver decorativo:
// que el código no vuelva por la respuesta, que un ticket no se pueda usar dos
// veces ni después de vencido, que un intento errado quede escrito, y que sin
// teléfono suscrito la acción no quede confirmable en silencio.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-mcp-tickets-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_DATA_DIR = dir;
// Un par VAPID válido para que el canal exista; el envío real se sustituye por
// un transport de mentira, así que nada sale a la red.
process.env.MIKAMPUS_VAPID_PUBLIC =
  'BI9cBciA_aPNeIiVfiS5ME2LISio8Fl3fUrVbKenwAwKHRK-uD-514fBR_EgOcA7z-tQAJH95ujDiYNapR9aMy0';
process.env.MIKAMPUS_VAPID_PRIVATE = 'ib-xDkProwE2zytitoClJk329aP34JDI1-mYQU25SDI';
delete process.env.MIKAMPUS_SILENT; // el envío está gated por SILENT; acá queremos ejercerlo

const { db } = await import('../src/db.js');
db.exec('INSERT OR IGNORE INTO users (id) VALUES (1)');

const { saveSubscription, __setTransport } = await import('../src/webpush.js');
const tickets = await import('../src/mcp/tickets.js');
const { ACTION_TOOLS } = await import('../src/mcp/actions.js');
const { createMcpServer, registerActions } = await import('../src/mcp/server.js');

// Transport de mentira: guarda lo que habría salido al push service y puede
// simular un canal caído.
const pushed = [];
let pushFails = false;
__setTransport(async (subscription, payload) => {
  if (pushFails) throw Object.assign(new Error('push service caído'), { statusCode: 500 });
  pushed.push({ endpoint: subscription.endpoint, ...JSON.parse(payload) });
});

const DROP = { kind: 'drop_class', term: '1930', courseCode: 'ICC-233', classNbr: '4567' };
const codeOf = (notification) => notification.title.match(/(\d{6})/)[1];
const propose = ACTION_TOOLS.find((tool) => tool.name === 'propose_action');
const lastLog = () =>
  db.prepare('SELECT action, detail, portal_response, ok FROM action_log ORDER BY id DESC LIMIT 1').get();

try {
  // ── Sin teléfono suscrito no hay canal, y sin canal no hay ticket ───────
  // Es el caso que no puede degradar en silencio: si esto crea un pendiente,
  // alguien puede confirmar una baja sin haber recibido nunca un código.
  assert.equal(tickets.confirmationChannel().available, false, 'sin suscripciones no hay canal');
  await assert.rejects(
    () => tickets.createTicket(DROP),
    (error) => {
      assert.equal(error.name, 'NoConfirmationChannelError');
      assert.match(error.message, /no se propuso nada/, 'la respuesta dice que no pasó nada');
      assert.match(error.message, /Ajustes > Notificaciones/, 'y dice cómo habilitarlo');
      return true;
    }
  );
  assert.deepEqual(tickets.listPending(), [], 'no quedó ningún ticket confirmable');
  assert.equal(lastLog().action, 'mcp:confirm-sin-canal', 'el canal ausente queda en el audit log');

  saveSubscription(1, { endpoint: 'https://push.example/telefono', keys: { p256dh: 'k', auth: 'a' } }, 'iPhone');
  assert.deepEqual(tickets.confirmationChannel(), { available: true, devices: 1, reason: null });

  // ── Un sync es reversible: alcanza con confirmarlo a propósito ──────────
  const sync = await tickets.createTicket({ kind: 'sync', datasets: ['cart'] });
  assert.equal(sync.reversible, true);
  assert.equal(sync.requiresCode, false, 'leer del portal no cambia matrícula');
  assert.equal(pushed.length, 0, 'un sync no gasta una push');
  assert.deepEqual(tickets.authorize(sync.ticketId, null), { kind: 'sync', datasets: ['cart'] });

  // ── Una baja exige el código, y el código sale SOLO por push ────────────
  const proposal = await propose.run({ payload: DROP });
  const drop = proposal.payload;
  assert.equal(drop.reversible, false);
  assert.equal(drop.requiresCode, true);
  assert.equal(pushed.length, 1, 'el código salió al teléfono');
  const code = codeOf(pushed[0]);
  assert.match(drop.summary, /ICC-233/, 'el resumen lo redacta mikampus, no el modelo');

  // Lo que ve el agente: ni el resumen ni el payload estructurado del tool
  // pueden contener los seis dígitos. Si pudiera leerlos, la confirmación no
  // confirma nada.
  assert.equal(JSON.stringify(proposal).includes(code), false, 'el código no vuelve por la respuesta MCP');
  assert.equal(JSON.stringify(tickets.readTicket(drop.ticketId)).includes(code), false, 'ni al releer el ticket');
  assert.equal(JSON.stringify(tickets.listPending()).includes(code), false, 'ni al listar pendientes');
  assert.match(proposal.summary, /teléfono/, 'la respuesta dice dónde buscar el código');

  // La base guarda el hash, nunca los dígitos.
  const stored = db.prepare('SELECT code_hash FROM mcp_action_tickets WHERE id = ?').get(drop.ticketId);
  assert.equal(stored.code_hash.length, 64, 'el ticket guarda el hash del código');
  assert.equal(stored.code_hash.includes(code), false, 'y no los dígitos');

  // El feed local deja rastro de que se pidió confirmación, sin el secreto: el
  // feed vive en esta máquina, que es exactamente de donde el código se saca.
  const feed = db.prepare('SELECT title, body FROM notifications WHERE key = ?').get(`mcp-confirm:${drop.ticketId}`);
  assert.match(feed.title, /propuso una acción/, 'el feed avisa que hay algo esperando');
  assert.equal(`${feed.title}${feed.body}`.includes(code), false, 'el feed local no repite el código');

  // ── Un código errado cuenta intentos y queda escrito ────────────────────
  const wrong = code === '000000' ? '111111' : '000000';
  assert.throws(() => tickets.authorize(drop.ticketId, null), /código de confirmación/, 'sin código no se autoriza');
  assert.throws(() => tickets.authorize(drop.ticketId, wrong), /intento 1 de 3/, 'un código errado cuenta intentos');
  const rejected = lastLog();
  assert.equal(rejected.action, 'mcp:confirm-rechazado', 'el intento errado queda en el audit log');
  assert.equal(rejected.ok, 0);
  assert.match(rejected.portal_response, /intento 1 de 3/);
  assert.equal(rejected.portal_response.includes(code), false, 'el log tampoco filtra el código');

  assert.throws(() => tickets.authorize(drop.ticketId, wrong), /intento 2 de 3/);
  assert.throws(() => tickets.authorize(drop.ticketId, wrong), /quedó cancelado/, 'tres errados cancelan el ticket');
  assert.equal(lastLog().portal_response, 'código incorrecto 3 veces: ticket cancelado');
  assert.equal(tickets.readTicket(drop.ticketId).state, 'cancelled');
  assert.throws(() => tickets.authorize(drop.ticketId, code), /ya está en estado cancelled/, 'un ticket cancelado no revive');

  // ── Un solo uso: el código correcto sirve una vez y nada más ────────────
  const second = await tickets.createTicket(DROP);
  const secondCode = codeOf(pushed.at(-1));
  const payload = tickets.authorize(second.ticketId, secondCode);
  assert.equal(payload.courseCode, 'ICC-233');
  assert.equal(tickets.readTicket(second.ticketId).state, 'authorized', 'autorizar saca el ticket de pendiente');
  assert.throws(
    () => tickets.authorize(second.ticketId, secondCode),
    /ya está en estado authorized/,
    'el mismo código no da de baja la materia dos veces'
  );
  assert.equal(
    db.prepare('SELECT code_hash FROM mcp_action_tickets WHERE id = ?').get(second.ticketId).code_hash,
    null,
    'el hash se borra al usarse'
  );

  tickets.settle(second.ticketId, { ok: true, result: 'baja confirmada por el portal' });
  assert.equal(tickets.readTicket(second.ticketId).state, 'executed');
  const logged = lastLog();
  assert.equal(logged.action, 'mcp:drop_class', 'el audit log dice que la acción vino del MCP');
  assert.equal(logged.ok, 1);
  assert.equal(logged.portal_response, 'baja confirmada por el portal');

  // ── Un ticket vencido no se puede confirmar ────────────────────────────
  const stale = await tickets.createTicket(DROP, { now: new Date(Date.now() - 5 * 60_000) });
  const staleCode = codeOf(pushed.at(-1));
  assert.throws(() => tickets.authorize(stale.ticketId, staleCode), /estado expired/, 'un ticket vive tres minutos');

  // ── Un canal caído tampoco degrada a confirmable ────────────────────────
  // La suscripción existe, pero el push service rechaza el envío: el código no
  // llegó a ningún lado, así que el ticket no puede existir.
  pushFails = true;
  await assert.rejects(() => tickets.createTicket(DROP), /Ningún dispositivo aceptó/);
  pushFails = false;
  assert.equal(
    tickets.listPending().some((ticket) => ticket.kind === 'drop_class'),
    false,
    'no quedó nada pendiente de un envío que falló'
  );

  // ── Apagado por defecto: sin la bandera, las acciones ni se listan ──────
  const readOnly = createMcpServer({ allowActions: false });
  const readOnlyTools = Object.keys(readOnly._registeredTools);
  for (const name of ['propose_action', 'confirm_action', 'cancel_action', 'list_pending_actions']) {
    assert.ok(!readOnlyTools.includes(name), `${name} no existe sin --allow-actions`);
  }
  assert.ok(readOnlyTools.includes('get_overview'), 'las lecturas sí están');

  const withActions = createMcpServer({ allowActions: true });
  const registered = await registerActions(withActions);
  assert.deepEqual(registered.sort(), ['cancel_action', 'confirm_action', 'list_pending_actions', 'propose_action']);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ MCP acciones: apagadas por defecto, código de un solo uso por push al teléfono y rastro en action_log');
