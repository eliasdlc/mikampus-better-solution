import { db } from './db.js';
import { withPage } from './session.js';
import { syncCatalogSubject } from './peoplesoft/catalog.js';
import { syncSubjectTitles } from './peoplesoft/browseCatalog.js';
import * as scheduler from './scheduler.js';
import { readTerms } from './terms.js';

// Sync de catálogo programado (plan §7, Fase 5). El catálogo es lo único que
// envejece solo — la universidad abre grupos, cambia profesores y mueve aulas
// sin avisarle a nadie— y hasta ahora había que acordarse de correr
// scripts/sync-catalog.mjs a mano.
//
// Es también la operación más cara y más visible de la app contra el portal
// (riesgo #2 y #3 del plan: volumen y detección de tráfico programático), así
// que las guardas mandan sobre la funcionalidad:
//
//   1. Apagado por defecto. Se prende con CATALOG_CRON_AT=03:00 y no antes.
//   2. Fuera de pico, una vez al día, a la hora que diga esa variable.
//   3. UN subject por corrida, el más viejo: el catálogo rota entero sin que
//      ninguna noche se coma una hora de portal.
//   4. Jamás mientras haya inscripción en juego. Es la regla dura: la sesión de
//      Playwright es UNA y está en fila (ver session.js), así que un barrido de
//      20 minutos por delante del disparo de las 7am te deja fuera de la
//      materia. Un catálogo desactualizado se arregla; una inscripción perdida
//      espera al otro cuatrimestre.

const AT = process.env.CATALOG_CRON_AT ?? '';
const CAREER = process.env.SYNC_CAREER || 'GRDO';

let timer = null;

// "03:00" → {hour: 3, minute: 0}. Cualquier otra cosa es null: una hora mal
// escrita apaga el cron y lo dice, en vez de correr a una hora sorpresa.
export function parseAt(raw) {
  const m = (raw ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

// Próxima ocurrencia de esa hora local. Si ya pasó hoy, mañana.
export function nextRun({ hour, minute }, now = new Date()) {
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
}

// Los subjects que vale la pena refrescar: los de las materias que todavía te
// faltan. Sale del pénsum ya guardado (no toca el portal), y si no hay pénsum,
// de lo que el catálogo local ya conozca. Barrer subjects de materias aprobadas
// es gastar navegaciones contra el portal para nada.
export function subjectsToSync() {
  const desdeEnv = (process.env.CATALOG_CRON_SUBJECTS ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (desdeEnv.length) return desdeEnv;

  const pendientes = db
    .prepare(`SELECT DISTINCT subject FROM pensum WHERE status = 'pending' ORDER BY subject`)
    .all()
    .map((r) => r.subject);
  if (pendientes.length) return pendientes;

  return db.prepare(`SELECT DISTINCT subject FROM courses ORDER BY subject`).all().map((r) => r.subject);
}

// El subject cuyo catálogo lleva más tiempo sin refrescarse; los que nunca se
// sincronizaron van primero (NULL ordena antes). Así cada noche toca uno y en
// unas semanas el catálogo entero rotó, sin barridos de una hora.
//
// El LIKE es por el formato que escribe syncCatalogSubject: detail es el
// subject, o "ICC (sin trocear: ...)" cuando algún prefijo excedió el límite.
export function syncTerm() {
  return process.env.SYNC_TERM || readTerms().next?.code || null;
}

export function stalestSubject(subjects, term = syncTerm()) {
  if (!term) return null;
  const last = db.prepare(
    `SELECT MAX(finished_at) AS at FROM sync_log
     WHERE kind = 'catalog' AND term = ? AND (detail = ? OR detail LIKE ? || ' (%')`
  );
  return subjects
    .map((subject) => ({ subject, at: last.get(term, subject, subject)?.at ?? null }))
    .sort((a, b) => (a.at ?? '') .localeCompare(b.at ?? ''))[0]?.subject ?? null;
}

// La guarda dura. Devuelve el motivo por el que NO se puede correr, o null si
// hay vía libre.
export function blockedBecause(state = scheduler.getState()) {
  if (state.schedule) return 'hay una inscripción programada: la sesión del portal tiene que estar libre';
  if (state.watcher) return 'el watcher está vigilando cupos';
  return null;
}

async function run() {
  const bloqueo = blockedBecause();
  if (bloqueo) {
    scheduler.emitEvent({ type: 'log', message: `Sync de catálogo pospuesto — ${bloqueo}` });
    return schedule();
  }

  const term = syncTerm();
  if (!term) {
    scheduler.emitEvent({ type: 'log', message: 'Sync de catálogo pospuesto — no se conoce el próximo ciclo' });
    return schedule();
  }
  const subject = stalestSubject(subjectsToSync(), term);
  if (!subject) {
    scheduler.emitEvent({ type: 'log', message: 'Sync de catálogo: no hay subjects que refrescar' });
    return schedule();
  }

  scheduler.emitEvent({ type: 'log', message: `Sync de catálogo: ${subject} (término ${term})…` });
  try {
    // Un subject son dos pantallas: los títulos (una carga) y el barrido de
    // secciones (muchas, troceadas). syncCatalogSubject deja su rastro en
    // sync_log, que es de donde sale el StalenessTag y el orden de la rotación.
    const { saved: titulos } = await withPage((page) => syncSubjectTitles(page, { subject }));
    const { saved, skipped } = await withPage((page) => syncCatalogSubject(page, { term, career: CAREER, subject }));

    scheduler.emitEvent({
      type: 'log',
      message: `Catálogo de ${subject}: ${saved} sección(es), ${titulos} título(s)${
        skipped.length ? ` · sin trocear: ${skipped.join(', ')}` : ''
      }`,
    });
  } catch (err) {
    // Falla el sync de una noche, no la app: mañana se reintenta solo. Se
    // notifica igual porque un cron que falla en silencio es un cron que no
    // existe, y el catálogo se iría poniendo viejo sin que nadie lo note.
    scheduler.emitEvent({
      type: 'notice',
      level: 'error',
      title: `El sync de catálogo de ${subject} falló`,
      body: err.message,
      key: `catalog-cron-error:${subject}`,
    });
  }
  schedule();
}

function schedule() {
  const at = parseAt(AT);
  if (!at) return;
  clearTimeout(timer);
  const proxima = nextRun(at);
  timer = setTimeout(() => run().catch(() => {}), proxima.getTime() - Date.now());
  console.log(`[cron] próximo sync de catálogo: ${proxima.toLocaleString('es-DO')}`);
}

export function startCatalogCron() {
  if (!AT) return null;
  const at = parseAt(AT);
  if (!at) {
    console.warn(`[cron] CATALOG_CRON_AT="${AT}" no es una hora válida (formato HH:MM) — el cron queda apagado`);
    return null;
  }
  schedule();
  return nextRun(at);
}

export function stopCatalogCron() {
  clearTimeout(timer);
  timer = null;
}
