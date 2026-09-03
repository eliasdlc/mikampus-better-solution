import { db, logSync, lastSync } from './db.js';
import { parseCalendarEvents, upcomingEvents, timelineEvents, todayInSantoDomingo } from './shared/academicCalendar.ts';

// El adaptador del calendario académico oficial (P3). Read-only, público y sin
// credenciales: son páginas abiertas de pucmm.edu.do. No pasa por la sesión de
// Playwright ni por la cola del portal, así que no compite con una inscripción.
//
// La regla de producto es que un fallo acá NUNCA bloquea Inicio: si la red se
// cayó o PUCMM cambió el markup, se sirve la caché diciendo de cuándo es.

export const CALENDAR_SOURCES = [{ key: 'general', url: 'https://pucmm.edu.do/calendarios/calendario-academico/' }];

// El calendario de preinscripción NO se parsea, y es una decisión, no un
// pendiente. El recon del 2026-08-09 encontró que esa página no publica
// `application/ld+json`: sus horarios por facultad viven solo en encabezados de
// presentación de WordPress. Extraerlos exigiría exactamente el tipo de parseo
// frágil que este plan descarta, y además publica horas POR FACULTAD, que no
// son la hora personal de nadie — presentarlas como tal sería la inferencia que
// el producto promete no hacer.
//
// Así que se enlaza en vez de leerse: la UI manda a la fuente oficial.
export const PREINSCRIPTION_URL = 'https://pucmm.edu.do/calendarios/calendario-de-preinscripcion/';

const FETCH_TIMEOUT_MS = 15_000;

// Costura de transporte para las pruebas: no se abre red en la suite.
let fetchPage = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'text/html' },
    });
    if (!res.ok) throw new Error(`${url} respondió ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
};

export function setCalendarFetcher(fn) {
  const previous = fetchPage;
  fetchPage = fn;
  return () => {
    fetchPage = previous;
  };
}

export function saveCalendarEvents(events, { now = new Date() } = {}) {
  const fetchedAt = now.toISOString();
  const insert = db.prepare(
    `INSERT INTO academic_calendar (event_id, title, starts_on, ends_on, url, source_url, fetched_at)
     VALUES (@id, @title, @startsOn, @endsOn, @url, @sourceUrl, @fetchedAt)
     ON CONFLICT(event_id) DO UPDATE SET
       title = excluded.title, starts_on = excluded.starts_on, ends_on = excluded.ends_on,
       url = excluded.url, source_url = excluded.source_url, fetched_at = excluded.fetched_at`
  );
  // Todo o nada: media caché de calendario es peor que la anterior completa.
  db.exec('BEGIN');
  try {
    for (const event of events) insert.run({ ...event, fetchedAt });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return events.length;
}

export function readCalendar({ limit = 5, past = 3, today = todayInSantoDomingo() } = {}) {
  const rows = db
    .prepare(
      `SELECT event_id AS id, title, starts_on AS startsOn, ends_on AS endsOn, url, source_url AS sourceUrl
       FROM academic_calendar ORDER BY starts_on, title`
    )
    .all();
  // `events` se conserva porque es lo que consume todo lo que ya existe; la
  // línea de tiempo se agrega al lado, sobre las MISMAS filas. El pasado nunca
  // estuvo en la base de otro modo: se descartaba acá al leer.
  return {
    events: upcomingEvents(rows, { today, limit }),
    timeline: timelineEvents(rows, { today, past, future: limit }),
    total: rows.length,
    syncedAt: lastSync('academicCalendar'),
  };
}

/**
 * Trae las dos páginas públicas y refresca la caché.
 *
 * Un fallo parcial no descarta lo que sí llegó: si el calendario general
 * respondió y el de preinscripción no, se guarda el primero y se reporta el
 * segundo. Cero eventos en TODAS las fuentes se trata como error visible —
 * significa que el markup cambió— pero deja la caché anterior intacta.
 */
export async function syncAcademicCalendar({ now = new Date() } = {}) {
  const collected = [];
  const failures = [];

  for (const source of CALENDAR_SOURCES) {
    try {
      const html = await fetchPage(source.url);
      const events = parseCalendarEvents(html, { sourceUrl: source.url });
      if (events.length === 0) failures.push(`${source.key}: la página respondió pero no publicó eventos`);
      collected.push(...events);
    } catch (err) {
      failures.push(`${source.key}: ${err.message}`);
    }
  }

  if (collected.length === 0) {
    const detail = failures.join(' · ') || 'sin eventos';
    logSync({ kind: 'academicCalendar', status: 'error', detail });
    // La caché vieja se conserva a propósito: una fecha de hace una semana es
    // infinitamente más útil que una pantalla vacía.
    const error = new Error(`No se pudo leer el calendario académico (${detail})`);
    error.keptCache = true;
    throw error;
  }

  const saved = saveCalendarEvents(collected, { now });
  logSync({
    kind: 'academicCalendar',
    status: 'ok',
    rows: saved,
    detail: failures.length ? `parcial — ${failures.join(' · ')}` : null,
  });
  return { saved, failures };
}
