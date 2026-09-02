import { db } from './db.js';
import { resolveTerms, labelFor, isStrmCode } from './shared/terms.ts';
import { writeDiagnostic, diagnosticsEnabled } from './diagnostics.js';

// La capa de disco del modelo de tiempo. shared/terms.ts hace la resolución
// pura (cuál ciclo corre hoy); esto llena y lee la tabla `terms`, el único
// lugar donde el STRM y la etiqueta en español viven en la misma fila.

// Nunca pisa un dato conocido con null: si la etiqueta ya trae código o fechas,
// una fuente que solo aporta la etiqueta no los borra (COALESCE). Así el orden
// en que llegan las fuentes (grades, enrollments, dropdown) no importa.
const upsertTermStmt = db.prepare(`
  INSERT INTO terms (code, label, start_date, end_date, updated_at)
  VALUES (?, ?, ?, ?, datetime('now'))
  ON CONFLICT(label) DO UPDATE SET
    code = COALESCE(excluded.code, terms.code),
    start_date = COALESCE(excluded.start_date, terms.start_date),
    end_date = COALESCE(excluded.end_date, terms.end_date),
    updated_at = datetime('now')
`);

// Registra un término. label es obligatorio (es la PK y la forma en que el
// estudiante lo reconoce); si solo tenemos el STRM y su fecha de inicio, la
// etiqueta se deriva del ciclo (labelFor). Sin etiqueta ni forma de derivarla,
// no se guarda: un STRM anónimo no le dice nada a nadie.
export function upsertTerm({ code = null, label = null, startDate = null, endDate = null }) {
  const resolvedLabel = label ?? labelFor({ code, label, startDate, endDate });
  if (!resolvedLabel) return false;
  upsertTermStmt.run(code, resolvedLabel, startDate, endDate);
  return true;
}

// Reconstruye la tabla `terms` desde lo que ya está en disco, sin tocar el
// portal: los STRM inscritos (con sus fechas de MTG_DATES) y las etiquetas del
// histórico de notas. Cruza los dos vocabularios derivando la etiqueta de un
// STRM a partir de su fecha de inicio (1 de septiembre → "Septiembre de 2026"),
// que es justo la etiqueta que grades ya usa: así 1930 y "Septiembre de 2026"
// terminan en la misma fila en vez de contarse dos veces.
//
// Idempotente: son upserts con COALESCE. Se corre al arrancar el server y
// después de sincronizar horario o notas. Devuelve la telemetría de lo que
// reconcilió (aliases unidos) para diagnostics.
export function reconcileTerms({ now = new Date() } = {}) {
  const telemetry = { converged: [], conflicts: [] };
  db.exec('BEGIN');
  try {
    // Términos inscritos, con sus fechas. `enrollments.term` es el IDENTIFICADOR
    // resuelto del ciclo: un STRM cuando `terms` ya lo conocía para la etiqueta, o
    // la propia etiqueta cuando no (View My Classes no expone el STRM). Por eso NO
    // todo `enrollments.term` es un STRM — tratarlo siempre como código era el bug
    // que escribía "Abril de 2026" en la columna `code`. isStrmCode decide de qué
    // vocabulario es cada valor y lo manda a la columna correcta.
    for (const row of db
      .prepare(
        `SELECT term AS id, MIN(start_date) AS start_date, MAX(end_date) AS end_date
         FROM enrollments GROUP BY term`
      )
      .all()) {
      if (isStrmCode(row.id)) {
        upsertTerm({ code: row.id, startDate: row.start_date, endDate: row.end_date });
      } else {
        upsertTerm({ label: row.id, startDate: row.start_date, endDate: row.end_date });
      }
    }
    // Etiquetas del histórico de notas. Si ya existen (porque un STRM las derivó),
    // el COALESCE deja intactos su código y fechas.
    for (const row of db.prepare('SELECT DISTINCT term AS label FROM grades WHERE term IS NOT NULL').all()) {
      upsertTerm({ label: row.label });
    }
    // Convergencia de identificador (§P0.2): cuando una etiqueta ya conoce su STRM,
    // el horario que se guardó por etiqueta se re-keyea al STRM para que no queden
    // dos horarios del mismo ciclo bajo identificadores distintos. Sin esto, en
    // cuanto aparece el STRM el ciclo se "enriquece" en `terms` pero el horario
    // viejo queda huérfano bajo la etiqueta (duplicación silenciosa).
    convergeEnrollmentIdentifiers(telemetry);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  recordReconciliation(telemetry, now);
  return telemetry;
}

// Re-keyea las inscripciones guardadas bajo la etiqueta de un ciclo hacia su STRM
// una vez que se conoce. readSchedule filtra enrollments por identificador, así
// que sin esto un ciclo que se sincronizó sin STRM y después lo obtuvo mostraría
// horario vacío bajo el nuevo identificador. No toca `sections` (readSchedule las
// une por section_id, no por term) para no chocar con el UNIQUE(term, class_nbr)
// del catálogo.
function convergeEnrollmentIdentifiers(telemetry) {
  const linked = db.prepare('SELECT code, label FROM terms WHERE code IS NOT NULL AND label IS NOT NULL').all();
  for (const { code, label } of linked) {
    if (code === label) continue; // fila corrupta (label-as-code): la sanea la migración
    const users = db.prepare('SELECT DISTINCT user_id FROM enrollments WHERE term = ?').all(label);
    for (const { user_id: userId } of users) {
      const hasCode = db.prepare('SELECT 1 FROM enrollments WHERE term = ? AND user_id = ? LIMIT 1').get(code, userId);
      if (hasCode) {
        // Un sync más nuevo ya escribió bajo el STRM: lo de la etiqueta es un
        // horario viejo del mismo ciclo. Se descarta el duplicado, no el reciente.
        const del = db.prepare('DELETE FROM enrollments WHERE term = ? AND user_id = ?').run(label, userId);
        if (del.changes) telemetry.converged.push({ from: label, to: code, userId, action: 'dropped-stale', rows: del.changes });
      } else {
        const upd = db.prepare('UPDATE enrollments SET term = ? WHERE term = ? AND user_id = ?').run(code, label, userId);
        if (upd.changes) telemetry.converged.push({ from: label, to: code, userId, action: 'rekeyed', rows: upd.changes });
      }
    }
  }
}

// Deja rastro de una reconciliación que movió datos (aliases unidos o conflictos),
// redactado, en la carpeta de diagnostics. Best-effort: no romper un sync porque
// no se pudo escribir el log. Una reconciliación que no movió nada no ensucia.
function recordReconciliation(telemetry, now) {
  if (!telemetry.converged.length && !telemetry.conflicts.length) return;
  if (!diagnosticsEnabled()) return;
  try {
    writeDiagnostic('term-reconciliation', JSON.stringify({ at: now.toISOString(), ...telemetry }, null, 2), { now });
  } catch {
    /* diagnostics es best-effort */
  }
}

// Lee todos los términos conocidos, ya resueltos contra hoy: cuál es el actual,
// cuál el siguiente, y de cada uno si tiene horario inscrito (enrollments) o
// secciones en el catálogo (plannable). El `term` es el identificador que el
// resto de la app usa: el STRM si lo hay, si no la etiqueta.
export function readTerms(today = new Date()) {
  const rows = db
    .prepare('SELECT code, label, start_date AS startDate, end_date AS endDate FROM terms')
    .all();
  const enrolled = new Set(db.prepare('SELECT DISTINCT term FROM enrollments').all().map((r) => r.term));
  const withSections = new Set(db.prepare('SELECT DISTINCT term FROM sections').all().map((r) => r.term));

  const { terms } = resolveTerms(rows, today);
  const enriched = terms.map((t) => ({
    term: t.code ?? t.label ?? '',
    code: t.code,
    label: t.label,
    startDate: t.startDate,
    endDate: t.endDate,
    sortKey: t.sortKey,
    isCurrent: t.isCurrent,
    isNext: t.isNext,
    // El horario se keyea por STRM cuando se conoce, si no por la etiqueta (View
    // My Classes no expone el STRM del ciclo en curso). Por eso hasSchedule mira
    // ambos: `enrollments.term` puede ser el código o la etiqueta.
    hasSchedule: (t.code != null && enrolled.has(t.code)) || (t.label != null && enrolled.has(t.label)),
    hasSections: t.code != null && withSections.has(t.code),
  }));

  return {
    terms: enriched,
    current: enriched.find((t) => t.isCurrent) ?? null,
    next: enriched.find((t) => t.isNext) ?? null,
  };
}

// Los identificadores equivalentes de un ciclo: el que se pasa más su STRM y su
// etiqueta si `terms` los conoce. Sirve para que una consulta hecha por un alias
// (p.ej. el STRM recién aparecido) encuentre datos guardados bajo el otro (la
// etiqueta con que se sincronizó antes de conocer el STRM), sin duplicar.
export function termAliases(term) {
  if (!term) return [];
  const row = db.prepare('SELECT code, label FROM terms WHERE code = ? OR label = ?').get(term, term);
  const aliases = new Set([term]);
  if (row?.code) aliases.add(row.code);
  if (row?.label) aliases.add(row.label);
  return [...aliases];
}

// El STRM del ciclo actual, para que un GET sin término pedido no caiga en uno
// futuro. Si el ciclo actual todavía no tiene STRM conocido (solo vive en
// grades como etiqueta), devuelve null: es más honesto un horario vacío que el
// de otro término. El siguiente sí sirve de fallback para pantallas de plan.
// El día entra por parámetro, como en readTerms. Leer el reloj acá adentro
// hacía que un test con una fecha fija igual quedara a merced del calendario:
// el 1 de septiembre de 2026 el ciclo 1930 pasó de "siguiente" a "actual" y la
// suite se rompió sola, sin que nadie tocara una línea.
export function currentTermCode(today = new Date()) {
  return readTerms(today).current?.code ?? null;
}

// Buscar, planner, pénsum y requisitos miran hacia el próximo ciclo. La única
// excepción es un término explícito en el request. TARGET_TERM dejó de existir:
// un valor global del proceso no puede gobernar el tiempo de cada pantalla.
export function planningTerm(requested = null, fallback = null, today = new Date()) {
  if (requested) return String(requested);
  return readTerms(today).next?.term ?? fallback ?? null;
}
