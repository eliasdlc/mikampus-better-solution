import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { dataPaths } from '../paths.js';
import { requireScraperMutationSupport } from '../scraperSupport.js';
import { actionPayloadSchema } from '../shared/mcp.ts';
import { agentState } from './kino.js';
import * as tickets from './tickets.js';

// El carril de ACCIÓN. Apagado por defecto: sin --allow-actions estas
// herramientas ni siquiera se listan, y un agente no puede llamar lo que no ve.
//
// Este proceso no ejecuta nada por su cuenta. No tiene Playwright, no tiene el
// lock del agente y no tiene la credencial del portal (el vault es otro archivo
// y este proceso nunca resuelve su ruta). Lo que hace es pedirle al agente que
// ya está corriendo que ejecute, por la MISMA API HTTP que usa la web. Así hay
// un solo dueño de las escrituras, del rate limit y del audit log.
//
// Si el agente no está corriendo, la herramienta lo dice y no se degrada a
// hacerlo por su cuenta.

const SESSION_COOKIE = 'mikampus_session';
const CSRF_HEADER = 'x-csrf-token';
const SESSION_TTL_MS = 2 * 60_000;

const SYNC_ROUTES = {
  mySchedule: '/api/my-schedule/sync',
  cart: '/api/cart/sync',
  grades: '/api/grades/sync',
  advisement: '/api/pensum/sync',
  holds: '/api/holds/sync',
  enrollmentWindows: '/api/enrollment-windows/sync',
};

function agentTokenValue() {
  const configured = process.env.MIKAMPUS_AGENT_TOKEN;
  if (configured) return configured.trim();
  const file = process.env.MIKAMPUS_AGENT_TOKEN_FILE || path.join(dataPaths().runtime, 'agent.token');
  return fs.readFileSync(file, 'utf8').trim();
}

async function agentBaseUrl() {
  const state = agentState();
  if (!state.running || !state.port) {
    throw new Error('El agente de mikampus no está corriendo: arrancalo y volvé a confirmar. No se ejecutó nada.');
  }
  const base = `http://127.0.0.1:${state.port}`;
  const response = await fetch(`${base}/api/health`, {
    headers: { 'x-mikampus-agent-token': agentTokenValue() },
    signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw new Error('El agente respondió pero rechazó el healthcheck autenticado.');
  return base;
}

// La API mutante del agente exige cookie de sesión y CSRF, que es lo correcto
// para un browser y lo que un proceso MCP no tiene. En vez de abrir un bypass de
// autenticación en el servidor, este módulo emite una sesión local propia, la
// usa por dos minutos y la revoca. Puede hacerlo porque ya tiene permiso de
// escritura sobre la base, o sea sobre el mismo directorio 0700 donde vive todo:
// no gana ningún privilegio que no tuviera. Lo que SÍ agrega la segunda barrera
// es el código de confirmación fuera de banda, sin el cual nada se ejecuta.
async function withLocalSession(run) {
  const db = new DatabaseSync(dataPaths().db);
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  try {
    db.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)').run(
      tokenHash,
      1,
      csrf,
      new Date(Date.now() + SESSION_TTL_MS).toISOString()
    );
    return await run({ token, csrf });
  } finally {
    db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE token_hash = ?").run(tokenHash);
    db.close();
  }
}

async function callAgent(base, route, body, credentials) {
  const host = new URL(base).host;
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `${SESSION_COOKIE}=${credentials.token}`,
      [CSRF_HEADER]: credentials.csrf,
      origin: `http://${host}`,
      host,
    },
    body: JSON.stringify(body ?? {}),
    // El scraping contra PeopleSoft es lento: un enroll son decenas de segundos.
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!response.ok) throw new Error(parsed?.error ?? `El agente respondió ${response.status}`);
  return parsed ?? {};
}

async function execute(payload) {
  const base = await agentBaseUrl();
  return withLocalSession(async (credentials) => {
    switch (payload.kind) {
      case 'sync': {
        const done = [];
        for (const dataset of payload.datasets) {
          const route = SYNC_ROUTES[dataset];
          if (!route) throw new Error(`El agente no expone una sincronización para ${dataset}`);
          await callAgent(base, route, {}, credentials);
          done.push(dataset);
        }
        return `Sincronizado: ${done.join(', ')}`;
      }
      case 'add_to_cart': {
        const result = await callAgent(
          base,
          '/api/search/add',
          {
            term: payload.term,
            career: payload.career,
            courseNumber: payload.courseNumber,
            classNbr: payload.classNbr,
            relatedClassNbr: payload.relatedClassNbr ?? undefined,
          },
          credentials
        );
        return result.alreadyInCart ? 'ya estaba en el carrito' : 'agregada al carrito';
      }
      case 'enroll_from_cart': {
        const result = await callAgent(base, '/api/enroll', { term: payload.term }, credentials);
        return JSON.stringify(result);
      }
      case 'drop_class': {
        // El contrato de la baja exige escribir el código exacto de la materia.
        // Se conserva tal cual: es la barrera que ya tenía la app.
        const result = await callAgent(
          base,
          '/api/my-schedule/drop',
          {
            term: payload.term,
            courseCode: payload.courseCode,
            classNbr: payload.classNbr ?? undefined,
            confirmCode: payload.courseCode,
          },
          credentials
        );
        return result.message ?? (result.ok ? 'baja confirmada' : 'la baja no fue confirmada por el portal');
      }
      default:
        throw new Error(`Acción desconocida: ${payload.kind}`);
    }
  });
}

export const ACTION_TOOLS = [
  {
    name: 'propose_action',
    config: {
      title: 'Proponer una acción',
      description:
        'Crea un ticket para una acción sobre el portal y NO la ejecuta. Devuelve un resumen redactado por mikampus y, cuando la acción cambia la matrícula, exige un código de confirmación de 6 dígitos que mikampus manda por notificación push al teléfono de Elias. Pedile ese código a él: acá nunca aparece. Si no hay ningún teléfono suscrito, esto falla y no propone nada.',
      inputSchema: { payload: actionPayloadSchema },
    },
    async run({ payload }) {
      const parsed = actionPayloadSchema.parse(payload);
      if (parsed.kind !== 'sync') requireScraperMutationSupport();
      const ticket = await tickets.createTicket(parsed);
      return {
        summary: `${ticket.summary} ${ticket.requiresCode ? `Pedile a Elias el código de 6 dígitos que le llegó al teléfono (${ticket.deliveredVia.join(', ')}). Vence ${ticket.expiresAt}.` : 'Confirmá con confirm_action.'}`,
        payload: ticket,
      };
    },
  },
  {
    name: 'confirm_action',
    config: {
      title: 'Confirmar y ejecutar una acción',
      description:
        'Ejecuta un ticket pendiente. Las acciones que cambian matrícula exigen el código de 6 dígitos que le llegó por push al teléfono de Elias; el ticket es de un solo uso y tres códigos errados lo cancelan. Cada intento errado queda registrado en el audit log de mikampus.',
      inputSchema: {
        ticketId: z.string(),
        code: z.string().optional().describe('Los 6 dígitos que mikampus le mandó por push a Elias'),
      },
    },
    async run({ ticketId, code }) {
      const payload = tickets.authorize(ticketId, code ?? null);
      try {
        const result = await execute(payload);
        const settled = tickets.settle(ticketId, { ok: true, result });
        return { summary: `Ejecutado: ${settled.summary} Respuesta del portal: ${result}`, payload: { ...settled, result } };
      } catch (error) {
        tickets.settle(ticketId, { ok: false, result: error.message });
        throw error;
      }
    },
  },
  {
    name: 'cancel_action',
    config: {
      title: 'Cancelar una acción propuesta',
      description: 'Descarta un ticket pendiente sin ejecutarlo.',
      inputSchema: { ticketId: z.string() },
    },
    async run({ ticketId }) {
      const ticket = tickets.cancelTicket(ticketId);
      return { summary: `Cancelado: ${ticket.summary}`, payload: ticket };
    },
  },
  {
    name: 'list_pending_actions',
    config: {
      title: 'Acciones propuestas sin resolver',
      description: 'Lista los tickets sin resolver con su resumen y cuándo vencen. Un ticket vive tres minutos.',
      inputSchema: {},
    },
    async run() {
      const pending = tickets.listPending();
      return {
        summary: pending.length === 0 ? 'No hay acciones pendientes.' : `${pending.length} acción(es) esperando confirmación.`,
        payload: { pending },
      };
    },
  },
];
