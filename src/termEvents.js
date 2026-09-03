import { db } from './db.js';
import { readTerms, termAliases } from './terms.js';
import { termEventSchema, termEventInputSchema } from './shared/schemas.ts';
import { resolveTermPhase } from './shared/termPhase.ts';
import { calendarEventsForTerm } from './shared/calendarPhases.ts';

// La capa de disco del calendario del ciclo. shared/termPhase.ts decide la etapa
// y las capacidades sin tocar nada; acá se lee y se escribe la tabla term_events,
// y se proyecta la única ventana que el portal sí publica.
//
// Nada se siembra: una base recién creada no tiene una sola fecha, y la app
// tiene que servir igual. Un evento sin fila es un evento desconocido, y el
// resolutor lo trata como tal.

// La ventana de Enrollment Dates NO se copia a term_events: enrollment_windows
// es el registro crudo de ese scrape y de él cuelga hasta cuándo vive la
// credencial cifrada (server.js) y el gate de la inscripción desatendida
// (scheduler.js). Duplicar la fila obligaría a mantener dos escrituras en
// sincronía para siempre. Se proyecta al leer, que es barato y no puede
// desincronizarse: lo que el portal dice hoy es lo que se ve hoy.
function projectedEnrollmentWindows(userId, terms) {
  if (!terms.length) return [];
  const placeholders = terms.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT session, starts_at, ends_at, precision, synced_at
       FROM enrollment_windows
       WHERE user_id = ? AND term_code IN (${placeholders})
       ORDER BY starts_at, session`
    )
    .all(userId, ...terms)
    .map((row) => ({
      event: 'inscripcion-regular',
      session: row.session,
      startsOn: row.starts_at,
      endsOn: row.ends_at,
      precision: row.precision,
      source: 'portal',
      sourceNote: 'enrollment-dates',
      updatedAt: row.synced_at,
    }));
}

// El calendario académico oficial, proyectado a etapas del ciclo. Misma
// decisión que con Enrollment Dates y por la misma razón: `academic_calendar`
// ya es el registro crudo de ese scrape, y copiar sus filas a term_events
// obligaría a mantener dos escrituras en sincronía para siempre. Se traduce al
// leer, que es barato y no puede desincronizarse.
//
// El módulo que decide qué título es qué etapa es puro (shared/calendarPhases.ts):
// acá solo se le pasan las filas y las fechas del ciclo.
function projectedCalendarEvents(termCode, termWindow) {
  const rows = db
    .prepare('SELECT event_id AS id, title, starts_on AS startsOn, ends_on AS endsOn FROM academic_calendar')
    .all();
  if (!rows.length) return [];
  return calendarEventsForTerm(rows, { termCode, termWindow }).map((hit) => ({
    event: hit.event,
    session: 'Regular Academic Session',
    startsOn: hit.startsOn,
    endsOn: hit.endsOn,
    precision: 'date',
    source: 'calendario',
    sourceNote: hit.title,
    updatedAt: null,
  }));
}

function storedEvents(userId, terms) {
  if (!terms.length) return [];
  const placeholders = terms.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT term_code, session, event, starts_on, ends_on, precision, source, source_note, updated_at
       FROM term_events
       WHERE user_id = ? AND term_code IN (${placeholders})
       ORDER BY starts_on, event`
    )
    .all(userId, ...terms)
    .map((row) => ({
      termCode: row.term_code,
      event: row.event,
      session: row.session,
      startsOn: row.starts_on,
      endsOn: row.ends_on,
      precision: row.precision,
      source: row.source,
      sourceNote: row.source_note,
      updatedAt: row.updated_at,
    }));
}

/**
 * Las fechas conocidas de un ciclo: las guardadas más la ventana que publica el
 * portal, ya validadas. La consulta pasa por termAliases porque un ciclo se
 * puede haber guardado bajo su STRM y pedirse por su etiqueta (o al revés), y
 * comparar `term` por igualdad exacta devolvería vacío justo el día en que
 * aparece el STRM.
 *
 * Precedencia al deduplicar: lo que el estudiante escribió le gana a lo que
 * proyecta el portal. Si corrigió una fecha a mano, un scrape no se la pisa; la
 * divergencia se ve porque ambas filas declaran su procedencia.
 */
export function readTermEvents(userId, term, termWindow = null) {
  const aliases = termAliases(term);
  const window = termWindow ?? termDates(term);
  const code = aliases.find((alias) => /^\d{4}$/.test(alias)) ?? null;
  const byKey = new Map();
  // El orden es de menos a más específico para vos: el calendario institucional
  // primero, después la ventana que el portal publica para tu cuenta, y al
  // final lo que escribiste a mano. Cada capa solo pisa a la anterior.
  for (const row of [
    ...projectedCalendarEvents(code, window),
    ...projectedEnrollmentWindows(userId, aliases),
    ...storedEvents(userId, aliases),
  ]) {
    const key = `${row.session}|${row.event}`;
    const previous = byKey.get(key);
    if (previous && previous.source === 'usuario' && row.source !== 'usuario') continue;
    byKey.set(key, row);
  }
  return [...byKey.values()].map((row) => termEventSchema.parse(row));
}

// Las fechas del ciclo, para atribuirle las filas del calendario que no lo
// nombran. Se leen acá y no en readTerms entero porque readTermEvents también
// se llama desde el endpoint, donde no hay una resolución de ciclo a mano.
function termDates(term) {
  const row = db
    .prepare('SELECT start_date AS startDate, end_date AS endDate FROM terms WHERE code = ? OR label = ?')
    .get(term, term);
  return { startDate: row?.startDate ?? null, endDate: row?.endDate ?? null };
}

const upsertEventStmt = db.prepare(`
  INSERT INTO term_events (user_id, term_code, session, event, starts_on, ends_on, precision, source, source_note, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, 'date', 'usuario', ?, datetime('now'))
  ON CONFLICT(user_id, term_code, session, event) DO UPDATE SET
    starts_on = excluded.starts_on,
    ends_on = excluded.ends_on,
    source = 'usuario',
    source_note = excluded.source_note,
    updated_at = datetime('now')
`);

/**
 * Reemplaza el calendario que el estudiante cargó para un ciclo por la lista
 * que manda. Reemplazo y no upsert incremental: así borrar una fecha es no
 * mandarla, sin un endpoint aparte, y el estado guardado siempre es exactamente
 * el que revisó y confirmó.
 *
 * Solo toca las filas source='usuario': lo que dijo el portal no se borra desde
 * acá. Y la escritura nunca inventa hora: precision queda en 'date' porque el
 * calendario académico se publica por día.
 */
export function saveTermEvents(userId, term, events) {
  const parsed = events.map((event) => termEventInputSchema.parse(event));
  const duplicated = parsed.find(
    (event, index) => parsed.findIndex((other) => other.event === event.event && other.session === event.session) !== index
  );
  if (duplicated) throw new Error(`El calendario trae dos veces la misma etapa: ${duplicated.event}`);

  db.exec('BEGIN');
  try {
    db.prepare("DELETE FROM term_events WHERE user_id = ? AND term_code = ? AND source = 'usuario'").run(userId, term);
    for (const event of parsed) {
      upsertEventStmt.run(userId, term, event.session, event.event, event.startsOn, event.endsOn, event.sourceNote);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return parsed.length;
}

/**
 * El ciclo sobre el que se responde cuando nadie pide uno: el que corre hoy y,
 * si hoy cae entre ciclos, el siguiente. Devuelve también sus fechas, que son
 * las que permiten inferir docencia y cierre sin que nadie tipee un calendario.
 */
export function resolveTermTarget(requested = null, today = new Date()) {
  const { terms, current, next } = readTerms(today);
  const wanted = requested ? new Set(termAliases(String(requested))) : null;
  const entry = wanted
    ? terms.find((t) => wanted.has(t.term) || (t.code && wanted.has(t.code)) || (t.label && wanted.has(t.label))) ?? null
    : current ?? next;

  if (!entry) {
    // Un ciclo que la base no conoce todavía no es un error: se responde sobre
    // él con lo que haya (nada), en vez de negar la pantalla entera.
    return { term: requested ? String(requested) : null, termLabel: null, startDate: null, endDate: null };
  }
  return { term: entry.term, termLabel: entry.label, startDate: entry.startDate, endDate: entry.endDate };
}

/**
 * La respuesta única desde la que el frontend gatea la app: etapa del ciclo,
 * cuánto falta, qué fechas faltan por cargar y el estado de cada capacidad con
 * su motivo. Todo el cálculo es puro; acá solo se junta con el disco.
 */
export function termPhase(userId, { term = null, today = new Date() } = {}) {
  const target = resolveTermTarget(term, today);
  const events = target.term
    ? readTermEvents(userId, target.term, { startDate: target.startDate, endDate: target.endDate })
    : [];
  const resolution = resolveTermPhase(events, { startDate: target.startDate, endDate: target.endDate }, today);
  return { ...target, ...resolution, events };
}
