import { db, lastSync } from './db.js';
import { readMeta, writeMeta } from './appMeta.js';
import { hasLiveCredentials, withPage } from './session.js';
import { readTerms, reconcileTerms, planningTerm } from './terms.js';
import { syncCart } from './peoplesoft/cart.js';
import { syncSchedule, latestScheduledTerm } from './peoplesoft/mySchedule.js';
import { fetchGrades, saveGrades, diffPublishedGrades, readGrades } from './peoplesoft/grades.js';
import { fetchAdvisement, saveRequirementTree, earliestGradeTerm } from './peoplesoft/advisement.js';
import { fetchHolds, saveHolds } from './peoplesoft/holds.js';
import { syncEnrollmentWindows } from './peoplesoft/enrollmentWindows.js';
import { syncAcademicCalendar } from './academicCalendar.js';
import * as scheduler from './scheduler.js';

// El orquestador de sincronización (P1). Antes cada pantalla decidía por su
// cuenta cuándo salir al portal: Layout refrescaba al montar, cada ruta tenía
// su botón, y `REFRESH_POLICY` era una lista plana sin dependencias. El
// resultado era que "actualizar" significaba una cosa distinta en cada lugar y
// que nadie podía responder "¿qué está viejo y por qué?".
//
// Acá hay una sola definición de frescura, una sola cola y un solo orden. Las
// reglas duras, en orden de prioridad:
//
//   1. Una inscripción en curso manda. Un submit jamás se interrumpe para
//      refrescar el carrito — el cupo no vuelve, el carrito sí.
//   2. Nunca dos operaciones de la misma fuente a la vez. Diez componentes
//      pidiendo lo mismo producen UNA consulta.
//   3. Sin sesión no se inventa custodia: la fuente queda `paused` con su
//      último dato bueno, no se persiste una credencial nueva para poder
//      refrescar en background.
//   4. Volver de dormir hace UNA pasada fresca, no el replay de los ticks que
//      se perdieron mientras la laptop estaba cerrada.

// ── Registro de fuentes ─────────────────────────────────────────────────────
// Cada fuente declara todo lo que el orquestador necesita saber de ella. El
// orden del array no decide nada: el orden real sale de `dependsOn`.

const HOUR = 60 * 60_000;

// Una fuente rota no vuelve a estar fresca nunca —la frescura mide el último
// ÉXITO— así que sin esta espera queda vencida para siempre y el tick la
// reintenta cada dos minutos indefinidamente. Con el parser de Enrollment Dates
// roto eso significó 734 consultas al portal de la universidad en ocho días,
// todas idénticas y todas fallidas. El error sigue visible en la UI: lo único
// que cambia es cada cuánto se vuelve a molestar a PeopleSoft.
const FAILURE_COOLDOWN_MS = 30 * 60_000;

// last_run_at se guarda con datetime('now'), que es UTC sin sufijo; last_success_at
// ya viene en ISO. Las dos formas pasan por acá para no repetir el parseo.
function toMillis(stamp) {
  if (!stamp) return null;
  const iso = stamp.includes('T') ? stamp : `${stamp.replace(' ', 'T')}Z`;
  const ms = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export const SOURCES = [
  {
    key: 'terms',
    label: 'Ciclos',
    // Descubrir y reconciliar ciclos va SIEMPRE primero: horario, carrito,
    // ventanas y watcher se cuelgan de la identidad que produce esta fuente.
    dependsOn: [],
    ttlMs: 6 * HOUR,
    needsPortal: false,
    invalidates: ['terms', 'term-context'],
    async run() {
      const result = reconcileTerms();
      return { detail: `${readTerms().terms.length} ciclo(s) conocidos`, result };
    },
  },
  {
    key: 'mySchedule',
    label: 'Horario',
    dependsOn: ['terms'],
    ttlMs: 12 * HOUR,
    needsPortal: true,
    invalidates: ['my-schedule', 'agenda', 'dashboard'],
    async run({ userId, onStep }) {
      const schedule = await withPage(userId, (page) => syncSchedule(page, { userId, onStep }));
      // El sync trae el STRM junto a la etiqueta: reconciliar acá cierra la
      // identidad del ciclo antes de que nadie lea el horario.
      reconcileTerms();
      return { detail: `${schedule.courses.length} materia(s) inscritas` };
    },
  },
  {
    key: 'enrollmentWindows',
    label: 'Ventana de inscripción',
    dependsOn: ['terms'],
    ttlMs: 6 * HOUR,
    needsPortal: true,
    invalidates: ['enrollment-windows', 'dashboard'],
    relevant: () => Boolean(enrollmentTerm()),
    async run({ userId, onStep }) {
      const windows = await withPage(userId, (page) => syncEnrollmentWindows(page, { userId, onStep }));
      return { detail: `${windows.length} sesión(es)` };
    },
  },
  {
    key: 'cart',
    label: 'Carrito',
    dependsOn: ['terms'],
    // Diez minutos es el TTL más corto de la app y es deliberado: el carrito es
    // lo único que cambia solo mientras mirás la pantalla.
    ttlMs: 10 * 60_000,
    needsPortal: true,
    invalidates: ['cart', 'dashboard'],
    // Fuera de un ciclo de inscripción, el carrito no cambia y consultarlo cada
    // diez minutos es castigar al portal por nada.
    relevant: () => cartIsRelevant(),
    async run({ userId }) {
      await withPage(userId, (page) => syncCart(page, { userId }));
      return { detail: 'carrito al día' };
    },
  },
  {
    key: 'grades',
    label: 'Notas',
    dependsOn: ['terms'],
    ttlMs: 24 * HOUR,
    needsPortal: true,
    invalidates: ['grades', 'goals', 'insights', 'trajectory', 'dashboard'],
    async run({ userId, emit }) {
      const previous = readGrades(userId);
      const { courses, mismatches } = await withPage(userId, (page) => fetchGrades(page, { userId }));
      const published = diffPublishedGrades(previous, courses);
      saveGrades(userId, courses);
      reconcileTerms();
      for (const course of published) {
        emit({
          type: 'notice',
          userId,
          title: `Se publicó tu nota de ${course.code}: ${course.grade}`,
          body: `${course.title ?? course.code} · ${course.term}`,
          key: `grade:${course.term}:${course.code}:${course.grade}`,
        });
      }
      for (const mismatch of mismatches) {
        emit({ type: 'log', userId, message: `⚠ El índice no cuadra con el portal — ${mismatch}` });
      }
      return { detail: `${courses.length} materia(s)` };
    },
  },
  {
    key: 'advisement',
    label: 'Avance',
    // Las proyecciones se recalculan DESPUÉS de notas: proyectar contra un
    // avance viejo y notas nuevas produce un número que no reconcilia con nada.
    dependsOn: ['grades'],
    ttlMs: 7 * 24 * HOUR,
    needsPortal: true,
    invalidates: ['pensum', 'requirements', 'profile', 'goals', 'dashboard'],
    async run({ userId }) {
      const data = await withPage(userId, (page) => fetchAdvisement(page, { userId }));
      const saved = saveRequirementTree(userId, data, { cohortStartTerm: earliestGradeTerm(userId) });
      return { detail: `${saved.groups} grupo(s), ${saved.pensum} materia(s)` };
    },
  },
  {
    key: 'academicCalendar',
    label: 'Calendario académico',
    dependsOn: [],
    // Una vez al día alcanza: PUCMM publica el calendario del año, no un feed.
    ttlMs: 24 * HOUR,
    // No es PeopleSoft: son páginas públicas. No necesita sesión, no toca la
    // cola de Playwright y por eso no cede ante una inscripción en curso —
    // un fetch HTTPS a pucmm.edu.do no le quita el turno a nadie.
    needsPortal: false,
    // El dato es institucional, no personal: su frescura no se guarda por usuario.
    shared: true,
    invalidates: ['academic-calendar', 'dashboard'],
    async run() {
      const { saved, failures } = await syncAcademicCalendar();
      return { detail: failures.length ? `${saved} fecha(s), parcial` : `${saved} fecha(s)` };
    },
  },
  {
    key: 'holds',
    label: 'Holds',
    dependsOn: [],
    ttlMs: 12 * HOUR,
    needsPortal: true,
    invalidates: ['holds', 'dashboard'],
    async run({ userId }) {
      const parsed = await withPage(userId, (page) => fetchHolds(page, { userId }));
      saveHolds(userId, parsed.holds);
      return { detail: parsed.holds.length ? `${parsed.holds.length} hold(s) activos` : 'sin holds' };
    },
  },
];

const BY_KEY = new Map(SOURCES.map((source) => [source.key, source]));

// Costura de transporte, no una alternativa de producto: deja que las pruebas
// ejerciten orden, relevancia, prioridad y colapso de concurrencia sin abrir
// Chromium ni tocar PUCMM. Mismo patrón que setSharedWatcherScanner.
const runnerOverrides = new Map();

export function setSourceRunner(key, fn) {
  if (!BY_KEY.has(key)) throw new Error(`Fuente de sincronización desconocida: ${key}`);
  const previous = runnerOverrides.get(key);
  runnerOverrides.set(key, fn);
  return () => {
    if (previous) runnerOverrides.set(key, previous);
    else runnerOverrides.delete(key);
  };
}

// ── Relevancia ──────────────────────────────────────────────────────────────

function enrollmentTerm() {
  const terms = readTerms();
  return terms.next?.code ?? terms.current?.code ?? null;
}

// El carrito importa cuando hay inscripción en juego: ya hay materias adentro,
// hay una ventana que no cerró, o hay un watcher/disparo esperando algo.
function cartIsRelevant() {
  const hasRows = db.prepare('SELECT 1 FROM cart_rows LIMIT 1').get();
  if (hasRows) return true;
  const openWindow = db
    .prepare("SELECT 1 FROM enrollment_windows WHERE ends_at >= date('now', '-1 day') LIMIT 1")
    .get();
  if (openWindow) return true;
  const watching = db.prepare("SELECT 1 FROM watchers WHERE status = 'running' LIMIT 1").get();
  if (watching) return true;
  return Boolean(db.prepare('SELECT 1 FROM schedules LIMIT 1').get());
}

// ── Orden por dependencias ──────────────────────────────────────────────────
// Topológico y determinista: dos corridas con el mismo registro producen el
// mismo orden, así el log de la cola se puede leer y comparar.

export function orderedSources(keys = SOURCES.map((source) => source.key)) {
  // Las keys pueden venir del body de una request: una fuente que no existe es
  // un error explícito, no un no-op silencioso que devolvería "todo al día"
  // sobre algo que jamás se consultó.
  for (const key of keys) {
    if (!BY_KEY.has(key)) throw new Error(`Fuente de sincronización desconocida: ${key}`);
  }
  const wanted = new Set(keys);
  const ordered = [];
  const seen = new Set();
  const visit = (key, trail = []) => {
    if (seen.has(key)) return;
    if (trail.includes(key)) throw new Error(`Dependencia circular entre fuentes: ${[...trail, key].join(' → ')}`);
    const source = BY_KEY.get(key);
    if (!source) throw new Error(`Fuente de sincronización desconocida: ${key}`);
    for (const dependency of source.dependsOn) visit(dependency, [...trail, key]);
    seen.add(key);
    ordered.push(source);
  };
  for (const source of SOURCES) if (wanted.has(source.key)) visit(source.key);
  return ordered;
}

// ── Persistencia del estado por fuente ──────────────────────────────────────

function readRow(userId, key) {
  return (
    db
      .prepare(
        `SELECT last_run_at AS lastRunAt, last_success_at AS lastSuccessAt,
                last_status AS lastStatus, last_error AS lastError
         FROM sync_sources WHERE user_id = ? AND source_key = ?`
      )
      .get(userId, key) ?? null
  );
}

function writeRow(userId, key, { status, error = null }) {
  // Tres hechos distintos: cuándo se intentó, cuándo funcionó por última vez, y
  // qué error hay ahora. Un fallo actualiza el intento y el error, y deja
  // intacto el último éxito — si no, la fuente parecería fresca justo cuando
  // más falta le hace reintentar.
  const successAt = status === 'ok' ? new Date().toISOString() : null;
  db.prepare(
    `INSERT INTO sync_sources (user_id, source_key, last_run_at, last_success_at, last_status, last_error)
     VALUES (?, ?, datetime('now'), ?, ?, ?)
     ON CONFLICT(user_id, source_key) DO UPDATE SET
       last_run_at = datetime('now'),
       last_success_at = COALESCE(excluded.last_success_at, sync_sources.last_success_at),
       last_status = excluded.last_status,
       last_error = excluded.last_error`
  ).run(userId, key, successAt, status, error);
}

// ── Cada cuánto se refresca lo que se scrapea ───────────────────────────────
//
// Cada fuente declara su frescura NATURAL: cada cuánto cambia el dato allá
// afuera. El avance académico no se mueve en una semana; el carrito sí cambia
// mientras mirás la pantalla.
//
// Encima de eso hay un techo global configurable: nada se queda más viejo que
// este intervalo. Es lo que hace verdadera la frase "los datos se actualizan
// cada hora" sin tener que tocar siete TTLs a mano, y es un techo y no un piso
// —el carrito sigue en diez minutos, porque el mínimo de los dos manda.
const SYNC_INTERVAL_KEY = 'sync.intervalMs';
export const DEFAULT_SYNC_INTERVAL_MS = HOUR;
export const MIN_SYNC_INTERVAL_MS = 15 * 60_000;
export const MAX_SYNC_INTERVAL_MS = 24 * HOUR;

export function syncIntervalMs() {
  // Contra null explícito: Number(null) es 0, y 0 acá significa "sin techo".
  // Sin esta guarda, no haber configurado nunca el intervalo desactivaba el
  // techo de una hora en vez de aplicarlo.
  const raw = readMeta(SYNC_INTERVAL_KEY);
  if (raw == null || raw === '') return DEFAULT_SYNC_INTERVAL_MS;
  const stored = Number(raw);
  if (!Number.isFinite(stored)) return DEFAULT_SYNC_INTERVAL_MS;
  // Cero es "sin techo": cada fuente se queda con su frescura natural. Existe
  // porque hay quien prefiere que el avance no se releva siete veces por semana
  // solo para cumplir una regla global.
  if (stored === 0) return 0;
  return Math.min(Math.max(Math.floor(stored), MIN_SYNC_INTERVAL_MS), MAX_SYNC_INTERVAL_MS);
}

export function setSyncIntervalMs(ms) {
  const value = Number(ms);
  const valid = value === 0 || (Number.isFinite(value) && value >= MIN_SYNC_INTERVAL_MS && value <= MAX_SYNC_INTERVAL_MS);
  if (!valid) {
    throw new Error(
      `El intervalo tiene que ser 0 (sin techo) o estar entre ${MIN_SYNC_INTERVAL_MS / 60_000} min y ${MAX_SYNC_INTERVAL_MS / HOUR} h`
    );
  }
  writeMeta(SYNC_INTERVAL_KEY, String(Math.floor(value)));
  return syncIntervalMs();
}

export function effectiveTtlMs(source) {
  const cap = syncIntervalMs();
  return cap > 0 ? Math.min(source.ttlMs, cap) : source.ttlMs;
}

function freshness(userId, source, now) {
  // El éxito vive en sync_log (la misma fila que alimenta el StalenessTag), no
  // en una segunda verdad que pueda desincronizarse. Las fuentes que no
  // escriben sync_log —`terms`, que es cálculo local— caen en su última corrida
  // registrada. El calendario sí escribe, y es compartido: va sin userId.
  // Frescura = último ÉXITO, nunca último intento. Un fallo no rejuvenece nada.
  const syncedAt =
    lastSync(source.key, source.shared ? {} : { userId }) ?? readRow(userId, source.key)?.lastSuccessAt ?? null;
  const ageMs = syncedAt ? now - new Date(`${syncedAt.replace(' ', 'T')}${syncedAt.endsWith('Z') ? '' : 'Z'}`).getTime() : null;
  const expired = ageMs == null || ageMs >= effectiveTtlMs(source);
  return { syncedAt, ageMs, expired };
}

/**
 * El estado completo del registro, sin tocar el portal. Es lo que pinta el
 * control global: qué fuente está fresca, cuál venció, cuál falló y por qué.
 */
export function syncState(userId, { now = Date.now() } = {}) {
  const hold = portalHold(userId);
  return {
    now: new Date(now).toISOString(),
    running: inFlight.has(userId),
    hold,
    interval: {
      ms: syncIntervalMs(),
      defaultMs: DEFAULT_SYNC_INTERVAL_MS,
      minMs: MIN_SYNC_INTERVAL_MS,
      maxMs: MAX_SYNC_INTERVAL_MS,
    },
    sources: SOURCES.map((source) => {
      const { syncedAt, ageMs, expired } = freshness(userId, source, now);
      const row = readRow(userId, source.key);
      const relevant = source.relevant ? source.relevant() : true;
      // El último intento falló: se respeta una espera antes de volver a salir
      // al portal. `expired` no se toca —la fuente SÍ está vencida y la UI tiene
      // que decirlo—; lo que se retrasa es el próximo intento automático.
      const lastRunMs = toMillis(row?.lastRunAt);
      const retryAt = row?.lastStatus === 'error' && lastRunMs != null ? lastRunMs + FAILURE_COOLDOWN_MS : null;
      return {
        key: source.key,
        label: source.label,
        dependsOn: source.dependsOn,
        // El TTL que de verdad rige, no el declarado: si el techo global lo
        // acorta, la UI tiene que mostrar el que se está aplicando.
        ttlMs: effectiveTtlMs(source),
        naturalTtlMs: source.ttlMs,
        needsPortal: source.needsPortal,
        syncedAt,
        ageMs,
        expired,
        relevant,
        lastRunAt: row?.lastRunAt ?? null,
        lastSuccessAt: syncedAt,
        lastStatus: row?.lastStatus ?? null,
        error: row?.lastError ?? null,
        retryAt: retryAt ? new Date(retryAt).toISOString() : null,
        cooling: retryAt != null && retryAt > now,
      };
    }),
  };
}

// ── Prioridad: quién manda sobre la única sesión de Playwright ──────────────

/**
 * Por qué el refresh NO puede salir ahora mismo. Devuelve la razón o null.
 * No es cortesía: `withPage` es una fila FIFO, así que encolar un refresh
 * delante de un submit lo retrasa de verdad.
 */
// Misma costura que el runner: la prueba necesita decidir si "hay sesión" sin
// montar un vault ni loguearse contra PUCMM.
let sessionProbe = hasLiveCredentials;

export function setSessionProbe(fn) {
  const previous = sessionProbe;
  sessionProbe = fn;
  return () => {
    sessionProbe = previous;
  };
}

export function portalHold(userId) {
  const critical = scheduler.portalPriorityHold(userId);
  if (critical) return critical;
  if (!sessionProbe(userId)) return 'sin sesión activa: iniciá sesión para volver a consultar el portal';
  return null;
}

// ── La corrida ──────────────────────────────────────────────────────────────

const inFlight = new Map();

/**
 * Actualiza lo que corresponda y devuelve qué hizo con cada fuente.
 *
 * - `force`: incluye las fuentes vigentes, no solo las vencidas. No evade
 *   consentimiento ni prioridad: una inscripción en curso sigue mandando.
 * - `keys`: acota a un subconjunto (y a sus dependencias).
 *
 * Dos llamadas concurrentes comparten la MISMA promesa: diez componentes
 * pidiendo refresh producen una sola pasada.
 */
export function pendingSync(userId) {
  return inFlight.get(userId) ?? null;
}

export function runSync(userId, { force = false, keys, emit = scheduler.emitEvent } = {}) {
  const pending = inFlight.get(userId);
  if (pending) return pending;
  const run = executeSync(userId, { force, keys, emit }).finally(() => inFlight.delete(userId));
  inFlight.set(userId, run);
  return run;
}

async function executeSync(userId, { force, keys, emit }) {
  const now = Date.now();
  const results = [];
  const hold = portalHold(userId);
  const failed = new Set();

  for (const source of orderedSources(keys)) {
    const { syncedAt, expired } = freshness(userId, source, now);
    const base = { key: source.key, label: source.label, syncedAt };

    // Una dependencia que falló invalida a quien depende de ella: refrescar el
    // avance contra unas notas que no se pudieron traer produce un número que
    // parece nuevo y no lo es.
    const blockedBy = source.dependsOn.find((dependency) => failed.has(dependency));
    if (blockedBy) {
      failed.add(source.key);
      results.push({ ...base, status: 'skipped', reason: `depende de ${BY_KEY.get(blockedBy).label}, que no se pudo actualizar` });
      continue;
    }

    if (source.relevant && !source.relevant()) {
      results.push({ ...base, status: 'skipped', reason: 'no aplica en este momento del ciclo' });
      continue;
    }

    if (!force && !expired) {
      results.push({ ...base, status: 'fresh' });
      continue;
    }

    if (source.needsPortal && hold) {
      // Pausado no es error: el dato cacheado sigue sirviendo y la UI explica
      // qué falta para volver a consultar.
      writeRow(userId, source.key, { status: 'paused', error: hold });
      results.push({ ...base, status: 'paused', reason: hold });
      continue;
    }

    emit({ type: 'log', userId, message: `Actualizando ${source.label.toLowerCase()}…` });
    try {
      const runner = runnerOverrides.get(source.key) ?? source.run;
      const outcome = await runner({
        userId,
        emit,
        onStep: (message) => emit({ type: 'log', userId, message }),
      });
      writeRow(userId, source.key, { status: 'ok' });
      results.push({
        ...base,
        status: 'updated',
        syncedAt: freshness(userId, source, Date.now()).syncedAt,
        detail: outcome?.detail ?? null,
        invalidates: source.invalidates,
      });
      // La invalidación es por evento y llega a TODAS las queries dependientes,
      // no solo a la pantalla que disparó el refresh.
      emit({ type: 'sync-source', userId, key: source.key, status: 'updated', invalidates: source.invalidates });
    } catch (err) {
      failed.add(source.key);
      writeRow(userId, source.key, { status: 'error', error: err.message });
      results.push({ ...base, status: 'error', error: err.message });
      emit({ type: 'log', userId, message: `No se pudo actualizar ${source.label.toLowerCase()}: ${err.message}` });
      emit({ type: 'sync-source', userId, key: source.key, status: 'error' });
    }
  }

  return results;
}

// ── El tick liviano ─────────────────────────────────────────────────────────
// Cada minuto se pregunta si algo venció. Casi siempre la respuesta es "no" y
// no cuesta nada: la consulta es a SQLite, no al portal.

const TICK_MS = 60_000;
// Tres ticks perdidos ya no son un tick tarde: son la laptop cerrada, el
// equipo dormido o un reboot. Se registra el gap y se hace UNA pasada.
const GAP_FACTOR = 3;

let tickTimer = null;
let lastTickAt = null;

export async function syncTick(userId, { now = Date.now(), emit = scheduler.emitEvent } = {}) {
  const previous = lastTickAt;
  lastTickAt = now;
  const gapMs = previous == null ? 0 : now - previous;
  const resumed = gapMs > TICK_MS * GAP_FACTOR;
  if (resumed) {
    emit({
      type: 'log',
      userId,
      message: `Se reanudó la sincronización tras ${Math.round(gapMs / 60_000)} min sin actividad; se hará una sola consulta fresca.`,
    });
  }

  const state = syncState(userId, { now });
  // `cooling` deja fuera lo que acaba de fallar. Un refresco pedido a mano no
  // pasa por acá: llama a runSync con sus keys y sale al portal igual.
  const due = state.sources.filter((source) => source.expired && source.relevant && !source.cooling);
  if (!due.length) return { ran: false, resumed, gapMs };
  // Reanudar no dispara el replay de los ticks perdidos: es la misma pasada
  // normal, que ya colapsa todo lo vencido en una sola corrida por fuente.
  const results = await runSync(userId, { keys: due.map((source) => source.key), emit });
  return { ran: true, resumed, gapMs, results };
}

export function startSyncLoop(userId, { emit = scheduler.emitEvent } = {}) {
  if (tickTimer) return tickTimer;
  lastTickAt = Date.now();
  tickTimer = setInterval(() => {
    syncTick(userId, { emit }).catch((err) => console.warn(`[sync] tick falló: ${err.message}`));
  }, TICK_MS);
  tickTimer.unref?.();
  return tickTimer;
}

export function stopSyncLoop() {
  clearInterval(tickTimer);
  tickTimer = null;
  lastTickAt = null;
}

// Solo para pruebas: reinicia el reloj del tick sin tocar timers reales.
export function resetTickClock(at = null) {
  lastTickAt = at;
}
