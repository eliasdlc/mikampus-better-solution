import { db } from './db.js';
import { resolveTerms, labelFor } from './shared/terms.ts';

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
// después de sincronizar horario o notas.
export function reconcileTerms() {
  db.exec('BEGIN');
  try {
    // STRM inscritos, con sus fechas. La etiqueta se deriva del ciclo.
    for (const row of db
      .prepare(
        `SELECT term AS code, MIN(start_date) AS start_date, MAX(end_date) AS end_date
         FROM enrollments GROUP BY term`
      )
      .all()) {
      upsertTerm({ code: row.code, startDate: row.start_date, endDate: row.end_date });
    }
    // Etiquetas del histórico de notas. Si ya existen (porque un STRM las derivó),
    // el COALESCE deja intactos su código y fechas.
    for (const row of db.prepare('SELECT DISTINCT term AS label FROM grades WHERE term IS NOT NULL').all()) {
      upsertTerm({ label: row.label });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
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
    hasSchedule: t.code != null && enrolled.has(t.code),
    hasSections: t.code != null && withSections.has(t.code),
  }));

  return {
    terms: enriched,
    current: enriched.find((t) => t.isCurrent) ?? null,
    next: enriched.find((t) => t.isNext) ?? null,
  };
}

// El STRM del ciclo actual, para que un GET sin término pedido no caiga en uno
// futuro. Si el ciclo actual todavía no tiene STRM conocido (solo vive en
// grades como etiqueta), devuelve null: es más honesto un horario vacío que el
// de otro término. El siguiente sí sirve de fallback para pantallas de plan.
export function currentTermCode() {
  return readTerms().current?.code ?? null;
}

// Buscar, planner, pénsum y requisitos miran hacia el próximo ciclo. La única
// excepción es un término explícito en el request. TARGET_TERM dejó de existir:
// un valor global del proceso no puede gobernar el tiempo de cada pantalla.
export function planningTerm(requested = null, fallback = null) {
  if (requested) return String(requested);
  return readTerms().next?.term ?? fallback ?? null;
}
