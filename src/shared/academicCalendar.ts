// El calendario académico oficial de PUCMM (P3). Es la única fuente de este
// producto que NO es PeopleSoft: son páginas públicas, sin login y sin datos
// personales, así que leerlas no toca la credencial ni la cola de Playwright.
//
// La página publica cada fecha como un bloque `application/ld+json` de
// schema.org/Event. Eso es lo que se parsea —el plan pide preferir datos
// estructurados— y no el HTML de presentación, que es de WordPress y cambia
// cada vez que alguien toca el tema.
//
// Todo lo de acá es puro: entra HTML, salen eventos. El fetch, la caché y la
// política de refresco viven en src/academicCalendar.js.

export type CalendarEvent = {
  /** El `@id` de schema.org: identificador oficial y estable del evento. */
  id: string;
  title: string;
  /** YYYY-MM-DD, ya normalizado y entendido en America/Santo_Domingo. */
  startsOn: string;
  endsOn: string;
  /** El enlace a la ficha oficial. La UI abre esto, no copia descripciones. */
  url: string | null;
  /** De qué página salió: el calendario general o el de preinscripción. */
  sourceUrl: string;
};

// PUCMM no zero-padea: publica "2026-8-10", no "2026-08-10". Pasarle eso a
// `new Date()` funciona de casualidad en V8 y con semántica de hora local, que
// es justo el tipo de suerte que produce un evento corrido un día. Se parsea a
// mano y se guarda como texto de fecha, sin horas ni zonas.
export function normalizeOfficialDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const match = raw.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (!match) return null;
  const [, year, month, day] = match;
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Santo Domingo es UTC-4 todo el año (República Dominicana no aplica horario de
// verano). "Hoy" se calcula con esa constante en vez de con la zona del equipo:
// una laptop en otra zona no puede correr el día académico.
const SANTO_DOMINGO_OFFSET_MS = 4 * 60 * 60_000;

export function todayInSantoDomingo(now: Date = new Date()): string {
  return new Date(now.getTime() - SANTO_DOMINGO_OFFSET_MS).toISOString().slice(0, 10);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&(?:#39|apos|rsquo);/g, "'");
}

function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = decodeEntities(raw.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return text.length ? text : null;
}

/**
 * Extrae los eventos de una página del calendario oficial.
 *
 * Un bloque roto no invalida la página: se salta y los demás siguen. Un cambio
 * de markup que deje CERO eventos sí es visible para el llamador (devuelve una
 * lista vacía) y ahí es donde se decide fallar de forma ruidosa.
 */
export function parseCalendarEvents(html: string, { sourceUrl }: { sourceUrl: string }): CalendarEvent[] {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const events: CalendarEvent[] = [];

  for (const [, raw] of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      continue;
    }
    const nodes = Array.isArray(parsed) ? parsed : [parsed];
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const record = node as Record<string, unknown>;
      const type = Array.isArray(record['@type']) ? record['@type'] : [record['@type']];
      if (!type.includes('Event')) continue;

      const title = cleanTitle(record.name);
      const startsOn = normalizeOfficialDate(record.startDate);
      if (!title || !startsOn) continue;

      // Un evento sin fin es de un día. Un fin anterior al inicio es un dato
      // malo del origen: se colapsa al inicio en vez de producir un rango que
      // la UI tendría que dibujar al revés.
      const endsOn = normalizeOfficialDate(record.endDate) ?? startsOn;
      events.push({
        id: typeof record['@id'] === 'string' && record['@id'] ? record['@id'] : `${sourceUrl}#${title}@${startsOn}`,
        title,
        startsOn,
        endsOn: endsOn < startsOn ? startsOn : endsOn,
        url: typeof record.url === 'string' && record.url ? record.url : null,
        sourceUrl,
      });
    }
  }

  return dedupeEvents(events);
}

function normalizedTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Dedupe por identificador oficial y, de respaldo, por título normalizado más
 * rango. El respaldo no es teórico: el calendario real publica "Último día de
 * docencia" dos veces el mismo día con `@id` distintos, y mostrarlo duplicado
 * haría dudar de todo lo demás.
 */
export function dedupeEvents(events: CalendarEvent[]): CalendarEvent[] {
  const byId = new Map<string, CalendarEvent>();
  for (const event of events) {
    if (!byId.has(event.id)) byId.set(event.id, event);
  }
  const byContent = new Map<string, CalendarEvent>();
  for (const event of byId.values()) {
    const key = `${normalizedTitle(event.title)}|${event.startsOn}|${event.endsOn}`;
    const existing = byContent.get(key);
    // Ante dos iguales gana el que trae enlace: es el que la UI puede abrir.
    if (!existing || (!existing.url && event.url)) byContent.set(key, event);
  }
  return [...byContent.values()].sort(
    (a, b) => a.startsOn.localeCompare(b.startsOn) || a.title.localeCompare(b.title)
  );
}

/**
 * Las próximas fechas institucionales. Un evento sigue siendo "próximo"
 * mientras su rango no haya terminado: un período de preinscripción de tres
 * días importa el segundo día tanto como el primero.
 */
export function upcomingEvents(
  events: CalendarEvent[],
  { today = todayInSantoDomingo(), limit = 5 }: { today?: string; limit?: number } = {}
): CalendarEvent[] {
  return events
    .filter((event) => event.endsOn >= today)
    .sort((a, b) => a.startsOn.localeCompare(b.startsOn) || a.title.localeCompare(b.title))
    .slice(0, limit);
}
