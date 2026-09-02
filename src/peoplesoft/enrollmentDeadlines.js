import { db, logSync } from '../db.js';
import { portalDateToISO } from './enrollmentWindows.js';
import { termAliases } from '../terms.js';
import { termEventSchema } from '../shared/schemas.ts';
import {
  MANAGE_CLASSES_START_URL,
  VIEW_MY_CLASSES_URL,
  ENROLLMENT_DEADLINES_LINK,
  ENROLLMENT_DEADLINES_PANEL,
} from './constants.js';

// Los plazos POR CLASE del calendario académico.
//
// Por qué existe este scraper habiendo ya enrollmentWindows.js: la pantalla de
// Enrollment Dates publica exactamente dos fechas del ciclo (cuándo empieza la
// sesión y hasta cuándo se inscribe) y nada más. La modificación de
// inscripción, la inscripción tardía, el retiro y las notas no están ahí, y sin
// ellas shared/termPhase.ts solo puede advertir. Esas fechas sí viven en la
// pantalla de plazos por clase, a la que se llega por el enlace "Enrollment
// Deadlines" de View My Classes (Fluid) o por el icono de deadlines del
// Student Center clásico.
//
// ESTADO HONESTO DE ESTE MÓDULO: no hay fixture de esa pantalla, así que no
// está confirmado ni el selector del panel ni qué etiquetas publica PUCMM. Lo
// que sí es sólido y ya está probado es todo lo que ocurre después de tener el
// HTML: el extractor es una función pura que corre con evaluate() y se prueba
// contra HTML armado a mano (scripts/test-enrollment-deadlines.mjs), el mapeo
// de etiqueta a etapa es una tabla explícita, y nada que no matche se acomoda a
// la regla más parecida: se reporta. El día que se capture la pantalla real con
// scripts/make-fixture.mjs quedan por confirmar dos cosas, ambas marcadas abajo
// con el comentario "PENDIENTE DE FIXTURE": los selectores de navegación y las
// etiquetas literales de DEADLINE_RULES.

/**
 * Extrae los pares etiqueta/fecha que muestre la pantalla de plazos.
 *
 * Corre dentro del browser vía evaluate(), así que no puede cerrar sobre nada
 * del módulo: todo lo que necesita va acá adentro.
 *
 * No busca etiquetas conocidas: recorre las dos gramáticas de PeopleSoft (la
 * grilla clásica PSLEVEL1GRID y las cajas Fluid ps_box-edit) y devuelve TODA
 * pareja cuyo valor tenga forma de fecha, con su etiqueta literal. Es
 * deliberado: no sabemos qué plazos publica PUCMM, y un extractor que solo
 * reconoce lo que ya esperábamos vuelve invisible lo que no esperábamos. Filtrar
 * por forma de fecha es lo que deja fuera aula, profesor y horario sin tener que
 * saber sus nombres, y decidir qué significa cada etiqueta es trabajo de node,
 * donde se puede reportar lo que no se entendió.
 */
export function extractEnrollmentDeadlines() {
  const clean = (value) => (value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const strip = (el) => (el ? clean(el.textContent) : '');
  // Las cuatro formas en que un portal PeopleSoft en español o en inglés
  // escribe un día. La numérica entra a propósito aunque sea ambigua: se
  // reporta como ilegible en node, que es más honesto que descartarla en
  // silencio o que adivinar si 03/09 es marzo o septiembre.
  const looksLikeDate = (value) =>
    /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{3,}\s+\d{1,2},\s*\d{4}$/.test(value) ||
    /^\d{1,2}\s+de\s+[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{3,}\s+de\s+\d{4}$/.test(value) ||
    /^\d{4}-\d{2}-\d{2}$/.test(value) ||
    /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value);

  const pairs = [];
  const seen = new Set();
  const add = (label, value, shape) => {
    const cleanLabel = clean(label);
    const cleanValue = clean(value);
    // Un valor largo es un párrafo de la pantalla, no el dato de una etiqueta.
    if (!cleanLabel || !cleanValue || cleanValue.length > 120) return;
    // En la grilla de una fila por plazo, la celda de la etiqueta se aparea
    // consigo misma. No es un dato: es la etiqueta mirándose al espejo.
    if (cleanLabel === cleanValue) return;
    const key = `${shape}|${cleanLabel}|${cleanValue}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ label: cleanLabel, value: cleanValue, shape, isDate: looksLikeDate(cleanValue) });
  };

  // Una cabecera que solo dice "Fecha" no nombra el plazo: en esa grilla la
  // etiqueta real es la primera celda de la fila.
  const generic = /^(date|fecha|deadline|plazo|value|valor|status|estado)$/i;

  // 1. Grilla clásica. Dos formas conviven: una columna por plazo (la etiqueta
  //    está en el <th>) y una fila por plazo (la etiqueta está en la primera
  //    celda). Se resuelven las dos sin saber de antemano cuál es.
  for (const table of document.querySelectorAll('table.PSLEVEL1GRID')) {
    const headers = [...table.querySelectorAll('th')].map((th) => strip(th));
    for (const row of table.querySelectorAll('tr')) {
      const cells = [...row.children].filter((cell) => cell.tagName === 'TD').map((cell) => strip(cell));
      if (!cells.length) continue;
      const rowLabel = cells.find((cell) => cell && !looksLikeDate(cell)) ?? '';
      cells.forEach((value, index) => {
        const header = headers[index] ?? '';
        const label = header && !generic.test(header) ? header : rowLabel || header;
        add(label, value, 'grid');
      });
    }
  }

  // 2. Cajas Fluid: <div class="ps_box-edit"><div class="ps_box-label"><span
  //    class="ps-label">…</span></div><span class="ps_box-value">…</span></div>.
  for (const value of document.querySelectorAll('.ps_box-value')) {
    const box = value.closest('.ps_box-edit') ?? value.parentElement;
    add(box ? strip(box.querySelector('.ps-label')) : '', strip(value), 'fluid');
  }

  // La sesión se toma solo de una etiqueta que se llame así y nada más:
  // "Session Begins On" nombra un plazo, no la sesión, y tomarla de ahí
  // guardaría los plazos bajo una sesión que no existe.
  const session = pairs.find((pair) => !pair.isDate && /^(session|sesi[oó]n)( name| de clase)?$/i.test(pair.label))?.value ?? null;

  return {
    // Mismo truco que enrollmentWindows: el STRM viaja en el estado de la
    // página, no en una celda visible.
    termCode: (document.documentElement.innerHTML.match(/STRM:"(\d+)"/) ?? [])[1] ?? null,
    session,
    title: clean(document.title),
    rows: pairs.filter((pair) => pair.isDate).map(({ label, value, shape }) => ({ label, value, shape })),
    // Lo que la pantalla mostró y no tenía forma de fecha. No se guarda nada de
    // esto: viaja para que un recon futuro pueda mirar qué se dejó afuera.
    ignoredPairs: pairs.filter((pair) => !pair.isDate).length,
  };
}

// ── Etiqueta del portal a etapa del ciclo ───────────────────────────────────

// Cada regla nombra una etiqueta de la pantalla y la etapa que le corresponde en
// el vocabulario de shared/termPhase.ts. `edge` dice si la fecha abre o cierra
// la ventana: casi todos los plazos por clase son un "hasta cuándo", y media
// ventana conocida es un dato válido en term_events.
//
// PENDIENTE DE FIXTURE: las etiquetas salen del juego que PeopleSoft entrega de
// fábrica para el calendario académico y de su traducción al español del portal.
// Hasta que se capture la pantalla real de PUCMM no está confirmado cuáles
// publica ni con qué texto exacto. Por eso el orden importa (lo específico va
// antes que lo general) y por eso lo que no matcha se reporta como desconocido
// en vez de caer en la regla más parecida.
//
// El texto se compara sin acentos y en minúsculas, así que los patrones se
// escriben sin acentos a propósito.
const DEADLINE_RULES = [
  {
    pattern: /modificacion de (inscripcion|seleccion)|last date to swap|swap deadline|add ?\/ ?drop|cambio de (asignatura|seccion)/,
    event: 'modificacion-inscripcion',
    edge: 'end',
  },
  {
    pattern: /inscripcion tardia|late enroll|enroll with (instructor )?permission|last date to enroll with/,
    event: 'inscripcion-tardia',
    edge: 'end',
  },
  {
    pattern: /last date to enroll|last day to enroll|ultima fecha (de|para) inscri|ultimo dia (de|para) inscri|fecha limite de inscripcion/,
    event: 'inscripcion-regular',
    edge: 'end',
  },
  // El retiro del ciclo completo va antes que el parcial: "withdraw from all
  // classes" también contiene "withdraw".
  {
    pattern: /retiro total|withdraw from all|term withdrawal|withdrawal from (the )?term|cancelacion del (ciclo|semestre|cuatrimestre)/,
    event: 'retiro-total',
    edge: 'end',
  },
  {
    pattern: /retiro parcial|last date to drop|last day to drop|drop deadline|dar de baja|baja de (asignatura|materia)/,
    event: 'retiro-parcial',
    edge: 'end',
  },
  // La etapa de notas empieza cuando el portal las publica, de ahí 'start'.
  {
    pattern: /publicacion de notas|entrega de notas|grades? (posted|available|posting)/,
    event: 'notas',
    edge: 'start',
  },
];

// Etiquetas que sí se entienden y aun así no se guardan, con el porqué. Sin esta
// lista el reporte gritaría por fechas que ya tenemos en otra tabla o que no
// pertenecen al vocabulario de etapas.
const IGNORED_RULES = [
  { pattern: /session (begins|ends)|begins on|ends on|fecha de (inicio|termino|fin)|inicio de (docencia|clases)/, reason: 'fecha del ciclo, ya vive en la tabla terms' },
  { pattern: /wait ?list/, reason: 'la lista de espera no es una etapa del ciclo' },
  { pattern: /refund|reembolso|devolucion/, reason: 'plazo de dinero, no de inscripción' },
  { pattern: /census|reporting date/, reason: 'fecha administrativa, sin efecto sobre lo que el estudiante puede hacer' },
];

// Un "withdraw" a secas en una pantalla POR CLASE puede ser el retiro de esa
// materia (retiro parcial con constancia) o el del ciclo entero, y de cuál sea
// depende qué control se apaga. Elegir uno sería inventar: se reporta y el
// estudiante carga la fecha a mano si la necesita.
const AMBIGUOUS_RULES = [
  {
    pattern: /withdraw|retiro|retirar/,
    reason: 'no dice si es el retiro de esta materia o el del ciclo completo',
  },
];

const withoutAccents = (value) =>
  (value ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * Qué etapa nombra una etiqueta del portal.
 *
 * Devuelve la etapa y el borde de la ventana cuando la reconoce; 'ignorada' con
 * su motivo cuando la entiende y no corresponde guardarla; 'ambigua' cuando el
 * texto admite dos lecturas incompatibles; y null cuando no la conoce.
 */
export function mapDeadlineLabel(label) {
  const text = withoutAccents(label);
  if (!text) return null;
  for (const rule of DEADLINE_RULES) {
    if (rule.pattern.test(text)) return { status: 'mapeada', event: rule.event, edge: rule.edge };
  }
  for (const rule of AMBIGUOUS_RULES) {
    if (rule.pattern.test(text)) return { status: 'ambigua', reason: rule.reason };
  }
  for (const rule of IGNORED_RULES) {
    if (rule.pattern.test(text)) return { status: 'ignorada', reason: rule.reason };
  }
  return null;
}

const SPANISH_MONTHS = new Map(
  ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'].map(
    (month, index) => [month, index + 1]
  )
);

/**
 * La fecha de un plazo, en ISO.
 *
 * Acepta las tres formas que sí se pueden leer sin adivinar: "September 3,
 * 2026" (la que ya usa Enrollment Dates), "3 de septiembre de 2026" e ISO. La
 * forma numérica corta se rechaza a propósito: 03/09/2026 es marzo o septiembre
 * según la configuración regional del portal, y una fecha equivocada acá apaga
 * un control el día que no debía.
 */
export function deadlineDateToISO(raw) {
  const value = (raw ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const spanish = withoutAccents(value).match(/^(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})$/);
  if (spanish) {
    const month = SPANISH_MONTHS.get(spanish[2]);
    if (!month) throw new Error(`Mes no reconocido en el plazo: ${value}`);
    return `${spanish[3]}-${String(month).padStart(2, '0')}-${String(Number(spanish[1])).padStart(2, '0')}`;
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value)) {
    throw new Error(`Fecha ambigua, no se sabe si es día/mes o mes/día: ${value}`);
  }
  return portalDateToISO(value);
}

/**
 * Convierte lo extraído en filas de term_events, y en un reporte de lo que no se
 * pudo convertir.
 *
 * No toca la base ni el reloj: se prueba con un objeto en la mano.
 *
 * `aliases` son los identificadores equivalentes del ciclo que se pidió. Si la
 * pantalla declara un STRM que no está entre ellos, la sincronización falla en
 * vez de escribir los plazos de un ciclo bajo el código de otro.
 */
export function parseEnrollmentDeadlines(raw, { term = null, aliases = [] } = {}) {
  const termCode = raw.termCode ?? term ?? null;
  if (!termCode) throw new Error('La pantalla de plazos no indicó el código de ciclo y no se pidió uno');
  if (raw.termCode && aliases.length && !aliases.includes(raw.termCode)) {
    throw new Error(`La pantalla de plazos es del ciclo ${raw.termCode}, no del pedido (${term})`);
  }

  const session = raw.session || 'Regular Academic Session';
  const merged = new Map();
  const unmapped = [];
  const ignored = [];
  const unreadable = [];

  for (const row of raw.rows ?? []) {
    const mapping = mapDeadlineLabel(row.label);
    if (!mapping) {
      unmapped.push({ label: row.label, value: row.value, reason: null });
      continue;
    }
    if (mapping.status === 'ambigua') {
      unmapped.push({ label: row.label, value: row.value, reason: mapping.reason });
      continue;
    }
    if (mapping.status === 'ignorada') {
      ignored.push({ label: row.label, value: row.value, reason: mapping.reason });
      continue;
    }

    let date;
    try {
      date = deadlineDateToISO(row.value);
    } catch (error) {
      unreadable.push({ label: row.label, value: row.value, error: error.message });
      continue;
    }

    // Dos etiquetas pueden caer en la misma etapa (el retiro "sin penalidad" y
    // el retiro "con penalidad" son los dos el retiro parcial). Se queda la
    // ventana más ancha, que es hasta cuándo el portal de verdad deja actuar, y
    // el source_note conserva las dos etiquetas para que la diferencia no se
    // pierda.
    const current = merged.get(mapping.event) ?? { startsOn: null, endsOn: null, labels: [] };
    if (mapping.edge === 'start') {
      current.startsOn = current.startsOn === null || date < current.startsOn ? date : current.startsOn;
    } else {
      current.endsOn = current.endsOn === null || date > current.endsOn ? date : current.endsOn;
    }
    if (!current.labels.includes(row.label)) current.labels.push(row.label);
    merged.set(mapping.event, current);
  }

  const events = [...merged.entries()].map(([event, window]) =>
    termEventSchema.parse({
      event,
      session,
      startsOn: window.startsOn,
      endsOn: window.endsOn,
      // El calendario académico se publica por día: la pantalla no trae hora y
      // acá no se inventa una.
      precision: 'date',
      source: 'portal',
      sourceNote: `enrollment-deadlines: ${window.labels.join('; ')}`,
    })
  );

  return { termCode, session, events, unmapped, ignored, unreadable };
}

// El portal no pisa una corrección hecha a mano: el WHERE del upsert protege las
// filas source='usuario', que es la misma regla que readTermEvents aplica al
// leer. Sin él, un scrape borraría en silencio la fecha que el estudiante
// corrigió en secretaría.
const upsertDeadline = db.prepare(`
  INSERT INTO term_events (user_id, term_code, session, event, starts_on, ends_on, precision, source, source_note, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, 'date', 'portal', ?, datetime('now'))
  ON CONFLICT(user_id, term_code, session, event) DO UPDATE SET
    starts_on = excluded.starts_on,
    ends_on = excluded.ends_on,
    precision = 'date',
    source = 'portal',
    source_note = excluded.source_note,
    updated_at = datetime('now')
  WHERE term_events.source <> 'usuario'
`);

/**
 * Guarda los plazos leídos del portal. Devuelve cuántas filas se escribieron de
 * verdad, que puede ser menos que los eventos recibidos: las que el estudiante
 * había corregido a mano no se tocan, y contarlas sería reportar una escritura
 * que no ocurrió.
 */
export function saveEnrollmentDeadlines(userId, termCode, events) {
  let written = 0;
  db.exec('BEGIN');
  try {
    for (const event of events) {
      const result = upsertDeadline.run(
        userId,
        termCode,
        event.session,
        event.event,
        event.startsOn,
        event.endsOn,
        event.sourceNote
      );
      written += Number(result.changes);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  logSync({ userId, kind: 'enrollmentDeadlines', term: termCode, status: 'ok', rows: written });
  return written;
}

async function findFrame(page, selector, timeout = 12_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    for (const frame of page.frames()) {
      try {
        if ((await frame.locator(selector).count()) > 0) return frame;
      } catch {
        // frame desprendido durante submitAction
      }
    }
    await page.waitForTimeout(300);
  }
  return null;
}

/**
 * Trae los plazos por clase del ciclo que el portal tenga seleccionado y los
 * guarda en term_events.
 *
 * Misma forma que syncEnrollmentWindows: recibe la página ya autenticada y
 * reporta cada paso. Devuelve lo parseado completo (eventos guardados más lo que
 * no se entendió), porque el reporte es la mitad del valor de este scraper: lo
 * que quedó sin mapear es exactamente la lista de etiquetas que hay que agregar
 * a DEADLINE_RULES cuando se capture el fixture.
 *
 * El ciclo lo decide el portal, no este scraper: se lee el STRM de la pantalla y
 * se verifica contra el pedido. Elegir otro ciclo en el selector de View My
 * Classes no está implementado, porque no hay fixture con el que confirmar el
 * control.
 */
export async function syncEnrollmentDeadlines(page, { userId, term = null, onStep = () => {} }) {
  try {
    onStep('abriendo View My Classes…');
    // El START del tile crea el navigation collection: abrir la hoja Fluid
    // directa en una sesión fresca tira bIsCalledOutsideNavigationCollection.
    await page.goto(MANAGE_CLASSES_START_URL, { waitUntil: 'commit' });
    await page.waitForTimeout(6_000);
    await page.goto(VIEW_MY_CLASSES_URL, { waitUntil: 'commit' });
    await page.waitForTimeout(6_000);

    let frame = await findFrame(page, ENROLLMENT_DEADLINES_LINK);
    if (!frame) {
      throw new Error(
        'View My Classes no mostró el enlace Enrollment Deadlines: sin materias inscritas en el ciclo, el portal no publica plazos por clase'
      );
    }
    onStep('abriendo Enrollment Deadlines…');
    await frame.locator(ENROLLMENT_DEADLINES_LINK).first().click();
    await page.waitForTimeout(6_000);

    // PENDIENTE DE FIXTURE: el panel de plazos se identifica por el selector de
    // constants.js, que todavía no se confirmó contra la pantalla real. Si no
    // aparece, se lee el frame donde estaba el enlace en vez de fallar: el
    // extractor filtra por forma de fecha, así que leer de más no ensucia el
    // resultado, y quedarse sin leer sí lo perdería.
    frame = (await findFrame(page, ENROLLMENT_DEADLINES_PANEL, 8_000)) ?? frame;

    onStep('leyendo los plazos publicados…');
    const raw = await frame.evaluate(extractEnrollmentDeadlines);
    if (!raw.rows.length) {
      throw new Error('La pantalla de plazos abrió pero no mostró ninguna fecha legible: hace falta capturar el fixture con scripts/make-fixture.mjs');
    }

    const parsed = parseEnrollmentDeadlines(raw, { term, aliases: term ? termAliases(term) : [] });
    for (const row of parsed.unmapped) {
      console.warn(`Plazo sin mapear: "${row.label}" = ${row.value}${row.reason ? ` (${row.reason})` : ''}`);
    }
    for (const row of parsed.unreadable) {
      console.warn(`Plazo ilegible: "${row.label}" = ${row.value} (${row.error})`);
    }
    if (!parsed.events.length) {
      throw new Error(
        `La pantalla de plazos publicó ${raw.rows.length} fecha(s) y ninguna etiqueta corresponde a una etapa conocida: ${raw.rows
          .map((row) => row.label)
          .join(' | ')}`
      );
    }

    saveEnrollmentDeadlines(userId, parsed.termCode, parsed.events);
    return parsed;
  } catch (error) {
    logSync({ userId, kind: 'enrollmentDeadlines', term, status: 'error', detail: error.message });
    throw error;
  }
}
