import { db, logSync } from '../db.js';

// Holds y pendientes del Centro del Alumnado.
//
// RECON PARCIAL — leer antes de tocar esto.
//
// El recon (fixtures/recon-student-center.html) encontró los dos paneles y su
// estado real: el estudiante NO tiene holds ni pendientes. El portal lo dice
// con un texto centinela dentro del panel ("No Holds.", "No To Do's."), y eso
// es lo único que este módulo puede afirmar con datos a la vista.
//
// Lo que NO se pudo confirmar, porque no hay ningún hold que mirar:
//   - Con qué estructura lista el portal un hold real (¿filas $N?, ¿una grilla?).
//   - Si expone la severidad, o sea si un hold dice que bloquea la inscripción.
//     El plan (5.8) quería pintar de rojo los bloqueantes; sin ese dato, la app
//     NO lo inventa: los holds salen con severidad 'unknown' y la pantalla
//     manda al portal para el detalle.
//
// Cuando aparezca un hold real: volcar el Student Center con `npm run
// recon:academico`, mirar la forma y recién ahí cerrar el parser y la
// severidad. Construir eso a ciegas ahora sería adivinar en rojo.

// Los paneles se acotan por contención DOM, nunca por índice: los ids con $N$
// del Student Center son globales a la página.
export const HOLDS_PANEL = 'win0divDERIVED_SSS_SCL_LS_PORT_HOLDS_LINK';
export const TODO_PANEL = 'win0divDERIVED_SSS_SCL_LS_PORT_TODO_LINK';

// El portal escribe el centinela en inglés aunque el resto esté en español.
const EMPTY_SENTINEL = /^\s*(no holds\.?|no to do'?s\.?|sin retenciones\.?)\s*$/i;

// Corre dentro del browser vía evaluate(): no puede cerrar sobre nada del
// módulo, así que los ids de los paneles van repetidos acá (las constantes de
// arriba son para el resto del código y para los tests).
export function extractHolds() {
  const strip = (el) => el.textContent.replace(/\s+/g, ' ').replace(/ /g, ' ').trim();

  const readPanel = (panelId) => {
    const panel = document.getElementById(panelId);
    if (!panel) return null;
    // Los valores del panel son los display-only; el resto es andamiaje
    // (etiquetas, flechas de colapsar) que no debe confundirse con un hold.
    return [...panel.querySelectorAll('span.PSEDITBOX_DISPONLY')].map(strip).filter(Boolean);
  };

  return {
    holds: readPanel('win0divDERIVED_SSS_SCL_LS_PORT_HOLDS_LINK'),
    todos: readPanel('win0divDERIVED_SSS_SCL_LS_PORT_TODO_LINK'),
  };
}

// Un panel que solo trae el centinela está vacío. Distinguirlo importa: si el
// centinela se colara como hold, el dashboard pintaría "1 hold activo" para
// siempre y la alerta dejaría de significar nada.
export function parseHolds({ holds, todos }) {
  const clean = (rows) => (rows ?? []).filter((t) => t && !EMPTY_SENTINEL.test(t));

  return {
    holds: clean(holds).map((title) => ({
      code: null,
      title,
      description: null,
      // 'unknown' y no 'info': no es que sepamos que no bloquea, es que el
      // portal no nos lo dijo. Ver el comentario de arriba.
      severity: 'unknown',
      link: null,
    })),
    todos: clean(todos).map((title) => ({ title })),
    // Si el panel no existe, el selector se rompió y eso NO es "no hay holds".
    holdsPanelFound: Array.isArray(holds),
    todosPanelFound: Array.isArray(todos),
  };
}

async function findFrame(page, selector, { timeout = 30000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const frame of page.frames()) {
      try {
        if ((await frame.locator(selector).count()) > 0) return frame;
      } catch {
        // frame desprendido a mitad de un AJAX; reintentar
      }
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`No se encontró el elemento esperado: ${selector}`);
}

export const STUDENT_CENTER_URL =
  'https://micampus.pucmm.edu.do/psp/cs92pro/EMPLOYEE/SA/c/SA_LEARNER_SERVICES.SSS_STUDENT_CENTER.GBL?Page=SSS_STUDENT_CENTER&Action=U';

export async function fetchHolds(page, { userId }) {
  await page.goto(STUDENT_CENTER_URL, { waitUntil: 'commit' });
  await page.waitForTimeout(8000);

  const frame = await findFrame(page, `[id="${HOLDS_PANEL}"]`);
  const parsed = parseHolds(await frame.evaluate(extractHolds));

  if (!parsed.holdsPanelFound) {
    logSync({ userId, kind: 'holds', status: 'error', detail: 'no se encontró el panel de holds', rows: 0 });
    throw new Error('El panel de holds no está donde el recon lo dejó: revisar selectores');
  }

  logSync({ userId, kind: 'holds', status: 'ok', detail: `${parsed.holds.length} hold(s)`, rows: parsed.holds.length });
  return parsed;
}

// Como el histórico de notas: el portal es la verdad y los holds se resuelven
// (dejan de existir), así que se reemplazan enteros en cada sync.
export function saveHolds(userId, holds) {
  db.prepare('DELETE FROM holds WHERE user_id = ?').run(userId);
  const insert = db.prepare(
    `INSERT INTO holds (user_id, code, title, description, severity, link, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  );
  for (const h of holds) insert.run(userId, h.code, h.title, h.description, h.severity, h.link);
  return holds;
}

export function readHolds(userId) {
  return db.prepare('SELECT code, title, description, severity, link FROM holds WHERE user_id = ?').all(userId);
}
