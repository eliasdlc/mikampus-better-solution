import fs from 'node:fs';
import path from 'node:path';
import { isStrmCode, cycleKey } from './shared/terms.ts';
// La regla del prefijo de sección vive en shared/campus.ts y se importa: el
// backfill y lo que la app infiere en caliente tienen que ser la misma regla, o
// una base migrada terminaría contradiciendo a la pantalla que la muestra.
import { campusFromLabel, CAMPUS_BY_SECTION_PREFIX } from './shared/campus.ts';

// Versionado de esquema (Fase 4 §6). Hasta acá el esquema se recreaba con
// `CREATE TABLE IF NOT EXISTS` en cada arranque: alcanza para agregar tablas,
// pero no dice en qué versión está una base, no puede fallar de forma segura a
// mitad de un cambio, y no distingue "esta base es vieja" de "esta base la
// escribió una versión más nueva de mikampus".
//
// El contrato ahora es explícito:
//   1. `PRAGMA user_version` es la verdad de la versión aplicada.
//   2. Cada migración corre en su propia transacción: aplica entera o no aplica.
//   3. Antes de la primera migración pendiente sobre una base existente se saca
//      una copia pre-upgrade. Es el camino de recuperación si algo sale mal.
//   4. Cada migración declara desde qué versión de esquema puede seguir leyendo
//      una versión anterior de la app (`minCompatibleVersion`). Con eso, un
//      binario viejo que abre una base nueva sabe si puede seguir o tiene que
//      parar antes de escribir.

export const BASELINE_VERSION = 1;

// La versión 1 es el esquema idempotente histórico que `db.js` sigue creando al
// importar: no se re-deriva acá para no reescribir tablas que ya existen en
// bases reales. La migración 1 solo la registra.
export const MIGRATIONS = [
  {
    version: 1,
    name: 'baseline',
    // Cualquier versión del esquema puede leer la baseline.
    minCompatibleVersion: 1,
    up() {},
  },
  {
    version: 2,
    name: 'lifecycle-metadata',
    // Solo agrega tablas nuevas: una app que espera la versión 1 las ignora y
    // sigue funcionando, así que un rollback a esquema 1 es seguro.
    minCompatibleVersion: 1,
    up(db) {
      db.exec(`
        -- Estado del producto que no es dato académico: modo de runtime elegido
        -- en el onboarding, última copia exitosa, preferencia de update-check.
        CREATE TABLE IF NOT EXISTS app_meta (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- El feed de notificaciones deja de vivir solo en memoria: el dedupe
        -- tiene que sobrevivir a un reinicio del agente (si no, cada arranque
        -- vuelve a notificar lo mismo) y el deep-link necesita un lugar donde
        -- guardarse.
        CREATE TABLE IF NOT EXISTS notifications (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id    INTEGER,
          key        TEXT NOT NULL,
          title      TEXT NOT NULL,
          body       TEXT NOT NULL DEFAULT '',
          urgency    TEXT NOT NULL DEFAULT 'normal',
          link       TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          read_at    TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_notifications_key ON notifications(key, created_at);

        -- Adaptadores de salida opcionales (Home Server). Nacen apagados y con
        -- destino visible: el contrato de egress se cumple con datos, no con
        -- una promesa en el README.
        CREATE TABLE IF NOT EXISTS notification_channels (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          kind         TEXT NOT NULL,
          label        TEXT NOT NULL,
          destination  TEXT NOT NULL,
          enabled      INTEGER NOT NULL DEFAULT 0,
          last_test_at TEXT,
          last_error   TEXT,
          created_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    version: 3,
    name: 'term-identity',
    // Solo sanea datos existentes; no cambia el esquema. Una app v1/v2 sigue
    // leyendo la base sin problema, así que el rollback de esquema es seguro.
    minCompatibleVersion: 1,
    up: repairTermIdentity,
  },
  {
    version: 4,
    name: 'watcher-scope',
    // Agrega una columna con DEFAULT: una app v1..v3 la ignora y sigue leyendo
    // y escribiendo watchers sin romperse, así que el rollback es seguro. El
    // default 'both' es deliberado — es exactamente lo que el watcher hacía
    // antes de que el alcance fuera elegible, así que una base existente no
    // cambia de comportamiento al migrar.
    minCompatibleVersion: 1,
    up(db) {
      // El baseline lo crea db.js antes de migrar, no una migración. Una base
      // mínima que solo ejercita el framework de migraciones no tiene la tabla,
      // y no tenerla no es un error: no hay nada que migrar.
      if (!tableExists(db, 'watchers')) return;
      const columns = db.prepare('PRAGMA table_info(watchers)').all();
      if (columns.some((column) => column.name === 'scope')) return;
      db.exec(`ALTER TABLE watchers ADD COLUMN scope TEXT NOT NULL DEFAULT 'both'`);
    },
  },
  {
    version: 5,
    name: 'sync-sources',
    // Solo agrega una tabla nueva de bookkeeping: una app v1..v4 la ignora y
    // sigue sincronizando con su lista vieja, así que el rollback es seguro.
    // Nada de lo que vive acá es dato del portal — es el registro de CUÁNDO se
    // intentó y con qué resultado, que hasta ahora solo existía en memoria y
    // por eso se perdía en cada reinicio.
    minCompatibleVersion: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_sources (
          user_id      INTEGER NOT NULL,
          source_key   TEXT NOT NULL,
          last_run_at  TEXT,
          last_status  TEXT,
          last_error   TEXT,
          PRIMARY KEY (user_id, source_key)
        );
      `);
    },
  },
  {
    version: 6,
    name: 'academic-calendar',
    // Tabla nueva y compartida: el calendario oficial no es de nadie en
    // particular, es público. Una app v1..v5 la ignora, así que el rollback es
    // seguro. No lleva user_id porque no hay nada personal acá — es justamente
    // la única fuente del producto que no sale de la cuenta de la persona.
    minCompatibleVersion: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS academic_calendar (
          event_id   TEXT PRIMARY KEY,
          title      TEXT NOT NULL,
          starts_on  TEXT NOT NULL,
          ends_on    TEXT NOT NULL,
          url        TEXT,
          source_url TEXT NOT NULL,
          fetched_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_academic_calendar_dates ON academic_calendar(starts_on, ends_on);
      `);
    },
  },
  {
    version: 7,
    name: 'sync-source-last-success',
    // `last_run_at` respondía "¿cuándo se intentó?" y se estaba usando también
    // para "¿cuándo funcionó?". No son lo mismo: con esa confusión, una fuente
    // que falla queda marcada como recién corrida y no se reintenta hasta que
    // venza su TTL — justo al revés de lo que debería pasar. Se separan.
    minCompatibleVersion: 1,
    up(db) {
      if (!tableExists(db, 'sync_sources')) return;
      const columns = db.prepare('PRAGMA table_info(sync_sources)').all();
      if (columns.some((column) => column.name === 'last_success_at')) return;
      db.exec('ALTER TABLE sync_sources ADD COLUMN last_success_at TEXT');
      // Una fila existente solo pudo haberse escrito con éxito o con error; las
      // que quedaron en 'ok' conservan su instante como último éxito conocido.
      db.exec("UPDATE sync_sources SET last_success_at = last_run_at WHERE last_status = 'ok'");
    },
  },
  {
    version: 8,
    name: 'section-field-provenance',
    // Dos pantallas del portal describen la misma sección y ninguna la describe
    // completa: View My Classes trae aula y horario pero no profesor, Class
    // Search trae profesor pero no sabe si estás inscrito. Sin recordar de dónde
    // salió cada campo, el último scrape en llegar pisaba al anterior y el
    // profesor desaparecía en cada sync de horario.
    //
    // Columnas nuevas y opcionales: una app v1..v7 las ignora y sigue leyendo
    // secciones igual, así que el rollback es seguro.
    minCompatibleVersion: 1,
    up(db) {
      if (!tableExists(db, 'sections')) return;
      const columns = db.prepare('PRAGMA table_info(sections)').all().map((column) => column.name);
      if (!columns.includes('instructor_source')) db.exec('ALTER TABLE sections ADD COLUMN instructor_source TEXT');
      if (!columns.includes('meetings_source')) db.exec('ALTER TABLE sections ADD COLUMN meetings_source TEXT');
    },
  },
  {
    version: 9,
    name: 'official-gpa',
    // El acumulado que PUBLICA PeopleSoft se leía en cada sync y se tiraba: solo
    // sobrevivía como texto en un mensaje de error si no cuadraba. Sin él
    // guardado no se puede usar como baseline de una proyección ni mostrar la
    // reconciliación, que es justo lo que P5 exige antes de proyectar nada.
    minCompatibleVersion: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS gpa_official (
          user_id          INTEGER PRIMARY KEY,
          gpa              REAL,
          units_toward_gpa REAL,
          grade_points     REAL,
          units_passed     REAL,
          term_label       TEXT,
          captured_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    version: 10,
    name: 'plan-item-related-section',
    // Solo agrega una columna nullable: una app v1..v9 la ignora y sigue
    // leyendo el plan como antes, con la teórica sola, así que el rollback es
    // seguro.
    minCompatibleVersion: 1,
    up: addPlanItemRelatedSection,
  },
  {
    version: 11,
    name: 'section-campus',
    // Solo agrega columnas nullable y un índice: una app v1..v10 las ignora y
    // sigue leyendo la base, así que volver a un esquema anterior es seguro.
    minCompatibleVersion: 1,
    up: addSectionCampus,
  },
  {
    version: 12,
    name: 'term-events',
    // Solo agrega una tabla nueva, y nace vacía: una app anterior no la conoce
    // y no pierde nada por ignorarla.
    minCompatibleVersion: 1,
    up: createTermEvents,
  },
  {
    version: 13,
    name: 'class-drop-deadlines',
    // Misma forma que la anterior: una tabla nueva que nace vacía.
    minCompatibleVersion: 1,
    up: createClassDropDeadlines,
  },
  {
    version: 14,
    name: 'pva-moodle',
    // Solo tablas nuevas con prefijo propio: una app de esquema 1 las ignora.
    minCompatibleVersion: 1,
    up: createPvaTables,
  },
  {
    version: 15,
    name: 'pva-archivos',
    minCompatibleVersion: 1,
    up: createPvaFileTables,
  },
  {
    version: 16,
    name: 'pva-avisos',
    minCompatibleVersion: 1,
    up: createPvaAlertTable,
  },
  {
    version: 17,
    name: 'pva-escrituras',
    minCompatibleVersion: 1,
    up: createPvaWriteTable,
  },
];


/**
 * Campus de cada sección, con su procedencia, más el campus del estudiante en
 * el perfil. Aditiva: solo columnas nullable y un índice.
 *
 * SQLite no admite CHECK en un ADD COLUMN, así que el esquema NO garantiza que
 * `campus` sea uno de los tres códigos: eso lo valida la capa de escritura con
 * campusCodeSchema (shared/campus.ts). Decirlo acá es más honesto que fingir
 * que la base lo impide.
 */
export function addSectionCampus(db) {
  const addedCampus = addColumnIfMissing(db, 'sections', 'campus', 'TEXT');
  addColumnIfMissing(db, 'sections', 'campus_source', 'TEXT');
  addColumnIfMissing(db, 'profile', 'home_campus', 'TEXT');
  if (tableExists(db, 'sections')) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_sections_term_campus ON sections(term, campus)');
    if (addedCampus) backfillSectionCampus(db);
  }
}


/**
 * Atribuye campus a las secciones que ya estaban en disco antes de que el
 * barrido supiera guardarlo. Dos pasos, en orden de autoridad, y ninguna fila
 * que no se pueda atribuir recibe un valor: queda en NULL explícito y la UI la
 * muestra como campus sin confirmar.
 *
 * Idempotente: el paso del portal solo escribe si el valor cambia y el de
 * inferencia solo toca filas sin campus, así que una segunda corrida es un
 * no-op incluso sobre la misma base.
 */
export function backfillSectionCampus(db) {
  if (!tableExists(db, 'sections')) return;

  // 1. Dato del portal. El carrito es la única pantalla scrapeada que dice el
  //    campus con todas las letras, pero no guarda el ciclo: cruzarlo por
  //    class_nbr solo es válido cuando ese número identifica UNA sola sección
  //    en toda la tabla. Con dos ciclos que reciclen el número, no se atribuye.
  if (tableExists(db, 'cart_rows')) {
    const rows = db
      .prepare(
        `SELECT class_nbr AS classNbr, MIN(campus) AS campus, COUNT(DISTINCT campus) AS labels
         FROM cart_rows WHERE class_nbr IS NOT NULL AND campus IS NOT NULL
         GROUP BY class_nbr`
      )
      .all();
    const update = db.prepare(
      `UPDATE sections SET campus = ?, campus_source = 'portal', updated_at = datetime('now')
       WHERE id = ? AND (campus IS NOT ? OR campus_source IS NOT 'portal')`
    );
    for (const row of rows) {
      if (row.labels !== 1) continue; // el mismo class_nbr con dos campus no dice nada
      const code = campusFromLabel(row.campus);
      if (!code) continue; // etiqueta que el portal cambió: mejor sin dato que adivinado
      const matches = db.prepare('SELECT id FROM sections WHERE class_nbr = ?').all(row.classNbr);
      if (matches.length !== 1) continue;
      update.run(code, matches[0].id, code);
    }
  }

  // 2. Inferencia por número de sección, marcada como tal. Nunca pisa un dato
  //    del portal porque solo toca filas todavía sin campus.
  for (const [prefix, code] of Object.entries(CAMPUS_BY_SECTION_PREFIX)) {
    db.prepare(
      `UPDATE sections SET campus = ?, campus_source = 'seccion', updated_at = datetime('now')
       WHERE campus IS NULL AND section LIKE ?`
    ).run(code, `${prefix}%`);
  }
}


/**
 * Las etapas del calendario académico de un ciclo (inscripción regular,
 * modificación, retiro, notas...). Nace VACÍA y se queda vacía hasta que una
 * fecha real la llene: el portal solo publica la ventana de Enrollment Dates y
 * el resto vive en el calendario que PUCMM publica fuera del portal. Sembrar
 * una fecha por defecto sería inventar el calendario del estudiante.
 *
 * Un evento es una VENTANA, no un instante: "del 4 al 8 hay modificación". Con
 * starts_on y ends_on nullable, media ventana conocida se guarda como tal en
 * vez de obligar a completar la que no se sabe.
 *
 * `source` distingue lo que dijo el portal de lo que escribió el estudiante, y
 * es lo que permite que un scrape no pise una corrección hecha a mano y que la
 * UI pueda decir de quién es cada fecha.
 *
 * enrollment_windows NO se absorbe acá: es el registro crudo del scrape de
 * Enrollment Dates y de él cuelga el cálculo de expiración de la credencial
 * cifrada. Proyectar esa ventana a term_events es trabajo de la capa que lee
 * el portal, no de una migración que no puede saber si la fecha sigue vigente.
 */
// Los plazos de baja POR CLASE que publica "Enrollment Deadlines".
//
// Tabla propia y no term_events, y la distinción es de fondo: term_events son
// las ETAPAS del ciclo, que valen para todo el mundo y deciden qué controles se
// apagan. Esto es por clase y por sesión, y solo dice qué le pasa a TU récord si
// das de baja esa clase. Meterlo en term_events habría hecho que "Drop with
// Penalty" del 5 de septiembre cerrara el retiro parcial que vence el 6 de
// noviembre.
export function createClassDropDeadlines(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS class_drop_deadlines (
      user_id      INTEGER NOT NULL DEFAULT 1,
      term_code    TEXT NOT NULL,
      class_nbr    TEXT NOT NULL,                 -- el NRC: los plazos son de la clase, no de la materia
      session      TEXT NOT NULL DEFAULT 'Regular Academic Session',
      delete_by    TEXT,                          -- ISO. Hasta acá la baja BORRA la clase del récord
      retain_by    TEXT,                          -- ISO. Hasta acá queda con estado 'dropped'
      penalty_from TEXT,                          -- ISO. Desde acá la baja lleva penalidad
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, term_code, class_nbr),
      -- Una fila sin ninguna de las tres fechas no dice nada: el plazo
      -- desconocido se representa con la ausencia de fila.
      CHECK (delete_by IS NOT NULL OR retain_by IS NOT NULL OR penalty_from IS NOT NULL)
    );

    CREATE INDEX IF NOT EXISTS idx_class_drop_deadlines_term
      ON class_drop_deadlines(user_id, term_code);
  `);
}

export function createTermEvents(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS term_events (
      user_id      INTEGER NOT NULL DEFAULT 1,
      term_code    TEXT NOT NULL,                 -- identificador resuelto del ciclo (STRM o etiqueta)
      session      TEXT NOT NULL DEFAULT 'Regular Academic Session',
      event        TEXT NOT NULL,                 -- inscripcion-regular / modificacion-inscripcion / inscripcion-tardia / retiro-parcial / retiro-total / notas
      starts_on    TEXT,                          -- ISO, nullable: media ventana es un dato válido
      ends_on      TEXT,
      precision    TEXT NOT NULL DEFAULT 'date',
      source       TEXT NOT NULL,                 -- quién dijo esta fecha
      source_note  TEXT,                          -- portal: qué pantalla. usuario: de dónde la copió
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, term_code, session, event),
      CHECK (source IN ('portal', 'usuario')),
      CHECK (precision IN ('date', 'datetime')),
      -- Una fila sin ninguna de las dos fechas no dice nada: el evento
      -- desconocido se representa con la ausencia de fila, no con una vacía.
      CHECK (starts_on IS NOT NULL OR ends_on IS NOT NULL)
    );

    CREATE INDEX IF NOT EXISTS idx_term_events_term ON term_events(user_id, term_code);
  `);
}


/**
 * La práctica que va pegada a una teórica dentro de un item del plan.
 *
 * Hasta acá un item guardaba UNA sección, así que un plan no podía ni expresar
 * "ICC-321 teórica 101 más práctica 171": mandaba la teórica al carrito y
 * PeopleSoft elegía la práctica por su cuenta, con lo cual el horario que la
 * app dibujaba no era el que terminaba inscrito.
 *
 * Es una columna y no una tabla de componentes porque es exactamente la forma
 * que usa el portal: su pantalla de agregar al carrito pide una clase y, si esa
 * clase tiene componentes relacionados, un radio para elegir cuál. Modelar N
 * componentes acá inventaría un grado de libertad que el portal no ofrece.
 */
export function addPlanItemRelatedSection(db) {
  addColumnIfMissing(db, 'plan_items', 'related_section_id', 'INTEGER REFERENCES sections(id) ON DELETE SET NULL');
}

// Las columnas que guardan el IDENTIFICADOR resuelto de un ciclo (STRM si se
// conoce, si no la etiqueta). Al fusionar dos filas del mismo ciclo, sus hijos
// se reapuntan al identificador canónico.
//
// Que `enrollments.term` mezcle los dos vocabularios (unas filas bajo "1930" y
// otras bajo "Abril de 2026") NO es corrupción y ninguna migración lo reescribe:
// es este contrato funcionando sobre un ciclo cuyo STRM el portal nunca expuso
// (View My Classes no lo publica). El día que aparezca, convergeEnrollmentIdentifiers
// re-keyea sin perder filas. El riesgo vivo está en el otro lado: los filtros
// que comparan `term` por igualdad exacta en vez de pasar por termAliases van a
// devolver vacío entre el momento en que se aprende el STRM y el momento en que
// corre la reconciliación. Eso se arregla en la capa de lectura, no acá:
// reescribir las filas a mano borraría la evidencia de qué vocabulario usó cada
// sync.
const RESOLVED_TERM_ID_COLUMNS = [
  ['enrollments', 'term'],
  ['sections', 'term'],
  ['plans', 'term'],
  ['goals', 'deadline_term'],
  ['enrollment_windows', 'term_code'],
  ['term_events', 'term_code'],
  ['sync_log', 'term'],
];

// Columnas que SIEMPRE guardan la etiqueta (histórico), nunca un STRM. Al
// fusionar, se reapuntan a la etiqueta canónica, no al código.
const LABEL_ONLY_TERM_COLUMNS = [
  ['grades', 'term'],
  ['pensum', 'taken_term'],
  ['progress_items', 'term'],
];

// La lista de columnas de arriba mira hacia adelante: nombra tablas que una
// migración posterior recién crea (term_events) y que por lo tanto no existen
// cuando corre la reparación de identidad sobre una base vieja. Una tabla
// ausente no tiene hijos que reapuntar, así que se salta en silencio.
function reassign(db, table, column, from, to) {
  if (from == null || from === to) return;
  if (!tableExists(db, table)) return;
  db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(to, from);
}

// Migración de identidad de ciclo (§P0.3). Repara la corrupción que el viejo
// reconcileTerms podía dejar —una etiqueta escrita en la columna `code`— y
// fusiona filas duplicadas del mismo ciclo. Corre dentro de la transacción de la
// migración: cualquier `throw` (colisión ambigua, choque de UNIQUE) hace ROLLBACK
// y conserva la copia pre-upgrade. Idempotente: una segunda corrida no encuentra
// nada que arreglar.
function tableExists(db, name) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;
}

export function repairTermIdentity(db) {
  // El baseline (tablas) lo crea db.js antes de migrar, no una migración. Si la
  // tabla `terms` no existe (una base mínima que solo prueba el framework, o una
  // instalación sin datos de ciclo), no hay identidad que reparar.
  if (!tableExists(db, 'terms')) return;

  // 1. Sanear label-as-code: un `code` que no es un STRM es una etiqueta que se
  //    coló por el bug. El STRM real es desconocido, así que la columna vuelve a
  //    NULL. La etiqueta (PK) sigue nombrando el ciclo.
  for (const row of db.prepare('SELECT code, label FROM terms WHERE code IS NOT NULL').all()) {
    if (!isStrmCode(row.code)) {
      db.prepare("UPDATE terms SET code = NULL, updated_at = datetime('now') WHERE label = ?").run(row.label);
    }
  }

  // 2. Fusionar filas del mismo ciclo (misma cycleKey) que quedaron separadas.
  const rows = db.prepare('SELECT code, label, start_date AS startDate, end_date AS endDate FROM terms').all();
  const groups = new Map();
  for (const row of rows) {
    const key = cycleKey(row);
    if (!key) continue; // un término que no se puede ubicar no se fusiona con nadie
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  for (const [key, group] of groups) {
    if (group.length < 2) continue;

    // Abortar ante ambigüedad: dos STRM distintos para el mismo ciclo no se pueden
    // reconciliar sin decidir cuál es real. Mejor parar y conservar el backup que
    // mezclar datos de dos identidades. (§P0 aceptación: conflicto imposible no
    // mezcla y deja diagnóstico.)
    const codes = [...new Set(group.map((r) => r.code).filter(Boolean))];
    if (codes.length > 1) {
      throw new Error(
        `Ciclo ${key}: dos STRM en conflicto (${codes.join(', ')}). No se puede fusionar sin perder datos; ` +
          'la base quedó sin tocar. Revisá y unificá manualmente, o restaurá la copia pre-upgrade.'
      );
    }

    const canonical = group.find((r) => r.code) ?? group.find((r) => r.startDate) ?? group[0];
    const code = codes[0] ?? null;
    const canonicalId = code ?? canonical.label;
    const startDate = group.map((r) => r.startDate).filter(Boolean).sort()[0] ?? null; // el más temprano
    const endDate = group.map((r) => r.endDate).filter(Boolean).sort().at(-1) ?? null; // el más tardío

    for (const row of group) {
      if (row.label === canonical.label) continue;
      // Reapuntar los hijos de la etiqueta descartada. Un UNIQUE que choque
      // (misma sección bajo dos identidades) lanza y aborta la migración entera.
      for (const [table, column] of RESOLVED_TERM_ID_COLUMNS) reassign(db, table, column, row.label, canonicalId);
      for (const [table, column] of LABEL_ONLY_TERM_COLUMNS) reassign(db, table, column, row.label, canonical.label);
      db.prepare('DELETE FROM terms WHERE label = ?').run(row.label);
    }

    // Enriquecer la canónica con los mejores valores del grupo.
    db.prepare(
      "UPDATE terms SET code = COALESCE(?, code), start_date = COALESCE(?, start_date), " +
        "end_date = COALESCE(?, end_date), updated_at = datetime('now') WHERE label = ?"
    ).run(code, startDate, endDate, canonical.label);
  }
}

// SQLite no admite `ADD COLUMN IF NOT EXISTS`, y una migración tiene que poder
// correr dos veces sin romper (un reintento después de un fallo la vuelve a
// ejecutar). Devuelve si la agregó, para que un backfill corra una sola vez.
function addColumnIfMissing(db, table, column, definition) {
  if (!tableExists(db, table)) return false;
  const exists = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return !exists;
}


/**
 * Saca de `terms` las fechas que son de OTRO ciclo.
 *
 * El bug que las dejó ahí ya está cerrado en el código (isStrmCode manda cada
 * valor a su columna y cycleLabel corta abril en el mes correcto), pero la
 * reparación de identidad solo devolvió `code` a NULL: la fila quedó con las
 * fechas del ciclo equivocado, y con ellas resolveTerms cree que dos ciclos
 * distintos corren en la misma ventana y cuál gana depende del orden de filas.
 *
 * El criterio es el mismo que usa labelFor para nombrar un ciclo por su fecha
 * de inicio: si la fecha de inicio guardada pertenece a otro ciclo que el que
 * nombra la etiqueta de la fila, las fechas no son suyas y se borran. Un ciclo
 * sin fechas cae a su ventana implícita, que es honesto; un ciclo con las
 * fechas de otro es una mentira con precisión de calendario.
 *
 * No fusiona ni borra filas: dos ciclos con notas propias son dos ciclos reales
 * del histórico, aunque compartan fechas por el bug. Idempotente: después de
 * borrarlas no hay nada que volver a mirar.
 */
export function repairTermDates(db) {
  if (!tableExists(db, 'terms')) return;
  const clear = db.prepare(
    "UPDATE terms SET start_date = NULL, end_date = NULL, updated_at = datetime('now') WHERE label = ?"
  );
  for (const row of db
    .prepare('SELECT label, start_date AS startDate, end_date AS endDate FROM terms WHERE start_date IS NOT NULL')
    .all()) {
    if (!row.label) continue;
    const byLabel = cycleKey({ code: null, label: row.label, startDate: null, endDate: null });
    const byDates = cycleKey({ code: null, label: null, startDate: row.startDate, endDate: row.endDate });
    if (!byLabel || !byDates || byLabel === byDates) continue;
    clear.run(row.label);
  }
}

export const SCHEMA_VERSION = MIGRATIONS.at(-1).version;

function currentVersion(db) {
  return Number(db.prepare('PRAGMA user_version').get().user_version ?? 0);
}

function databaseHasTables(db) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get();
  return row.n > 0;
}

function ensureLedger(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version                INTEGER PRIMARY KEY,
      name                   TEXT NOT NULL,
      min_compatible_version INTEGER NOT NULL,
      applied_at             TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

// Qué versión de esquema necesita como mínimo el código para poder leer esta
// base. Lo escribe la migración más reciente que se aplicó, así que una app
// vieja puede consultarlo sin conocer las migraciones nuevas.
export function minCompatibleVersion(db) {
  ensureLedger(db);
  const row = db.prepare('SELECT min_compatible_version AS min FROM schema_migrations ORDER BY version DESC LIMIT 1').get();
  return row ? Number(row.min) : BASELINE_VERSION;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

// La copia pre-upgrade no es el backup diario: es el punto de retorno de ESTE
// cambio de esquema y por eso lleva la versión de origen en el nombre.
export function preUpgradeBackup(db, { directory, from, now = new Date() }) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const target = path.join(directory, `pre-upgrade-v${from}-${stamp}.sqlite`);
  db.exec(`VACUUM INTO ${sqlString(target)}`);
  return target;
}

export class SchemaTooNewError extends Error {
  constructor(found, supported) {
    super(
      `Esta base de datos usa el esquema ${found} y esta versión de mikampus solo entiende hasta el ${supported}. ` +
        'Actualizá mikampus, o restaurá la copia pre-upgrade con `mikampus restore <archivo>`.'
    );
    this.code = 'MIKAMPUS_SCHEMA_TOO_NEW';
    this.found = found;
    this.supported = supported;
  }
}

export class MigrationFailedError extends Error {
  constructor(migration, cause, backup) {
    super(
      `Falló la migración ${migration.version} (${migration.name}): ${cause.message}. ` +
        (backup
          ? `Los datos quedaron en la versión anterior. Si la base quedó inconsistente, restaurá ${backup}.`
          : 'La base quedó en su versión anterior; no se aplicó ningún cambio parcial.')
    );
    this.code = 'MIKAMPUS_MIGRATION_FAILED';
    this.cause = cause;
    this.backup = backup ?? null;
  }
}

/**
 * Lleva la base al esquema que este binario entiende. Devuelve el detalle de lo
 * que hizo para poder registrarlo y mostrarlo en `status`/`doctor`.
 */
export function runMigrations(db, { backupDir, migrations = MIGRATIONS, onBackup, preexisting = true } = {}) {
  ensureLedger(db);
  const found = currentVersion(db);

  if (found > SCHEMA_VERSION) {
    // Una base más nueva: solo se sigue si ELLA declaró que un esquema como el
    // nuestro puede leerla. Escribir a ciegas sobre un esquema desconocido es
    // como se corrompe una base al hacer rollback de versión.
    const min = minCompatibleVersion(db);
    if (min > SCHEMA_VERSION) throw new SchemaTooNewError(found, SCHEMA_VERSION);
    return { from: found, to: found, applied: [], backup: null, downgraded: true };
  }

  // Una base preexistente creada antes del versionado ya tiene el esquema de la
  // baseline: se la adopta sin correr nada.
  const from = found === 0 && databaseHasTables(db) ? BASELINE_VERSION : found;
  const pending = migrations.filter((m) => m.version > from);
  if (pending.length === 0) {
    if (from !== found) {
      db.exec(`PRAGMA user_version = ${from}`);
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name, min_compatible_version) VALUES (?, ?, ?)')
        .run(BASELINE_VERSION, 'baseline', BASELINE_VERSION);
    }
    return { from, to: from, applied: [], backup: null, downgraded: false };
  }

  // Una base recién creada no tiene nada que rescatar; una que ya existía antes
  // de este arranque, sí. `preexisting` lo decide el caller porque para cuando
  // se llega acá el esquema baseline ya se creó y las tablas existen siempre.
  let backup = null;
  if (preexisting && from >= BASELINE_VERSION && backupDir) {
    backup = preUpgradeBackup(db, { directory: backupDir, from });
    onBackup?.(backup);
  }

  const applied = [];
  for (const migration of pending) {
    db.exec('BEGIN');
    try {
      migration.up(db);
      db.prepare('INSERT OR REPLACE INTO schema_migrations (version, name, min_compatible_version) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, migration.minCompatibleVersion ?? migration.version);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new MigrationFailedError(migration, error, backup);
    }
    // user_version no participa de la transacción de datos, así que se mueve
    // recién cuando la migración quedó confirmada.
    db.exec(`PRAGMA user_version = ${migration.version}`);
    applied.push(migration.version);
  }

  return { from, to: currentVersion(db), applied, backup, downgraded: false };
}


/**
 * Las tablas de la PVA (el Moodle de PUCMM). Aditiva: 22 tablas nuevas con
 * prefijo pva_, ninguna columna ni tabla existente se toca, así que una versión
 * anterior de la app las ignora y sigue leyendo la base.
 *
 * El SQL es el del mapa (MAPA-PVA.md), que se levantó campo por campo contra la
 * instancia real. Tres decisiones que se ven en el esquema y conviene no
 * redescubrir:
 *
 *   1. El prefijo pva_ no es cosmético. mikampus ya tiene courses y sections con
 *      el significado de PeopleSoft: una sección de la PVA es un bloque de la
 *      página de un curso, otra cosa y otro ciclo de vida.
 *   2. El 0 que Moodle manda en una fecha no es 1970, es "no hay fecha": entra
 *      como NULL y los CHECK impiden que se cuele un 0.
 *   3. Nada se borra en duro. Un módulo, un evento o un item que deja de venir
 *      se marca (missing_since, last_seen_at) porque puede volver, y borrarlo
 *      haría que reaparezca como novedad.
 *
 * pva_announcement, pva_alert y pva_conversation no se crean acá: la función que llena la primera
 * (mod_forum_get_forum_discussions) nunca se sondeó, la emisión de avisos es de
 * otra fase, y la bandeja de mensajes directos no la muestra ninguna pantalla
 * todavía. Una tabla que nadie llena es una promesa vacía en el esquema.
 * Los archivos (pva_file y compañía) tampoco: son de la fase de documentos.
 */
export function createPvaTables(db) {
  db.exec(`
    -- Una fila por usuario de mikampus: el token es de una persona y todo lo que
    -- devuelve site_info lo es también. No hay historial: la fila se pisa.
    CREATE TABLE IF NOT EXISTS pva_identity (
      user_id                INTEGER PRIMARY KEY,
      moodle_userid          INTEGER NOT NULL,   -- parámetro de casi todo el resto del API
      username               TEXT NOT NULL,      -- el login del portal, no necesariamente numérico
      firstname              TEXT,
      lastname               TEXT,
      fullname               TEXT,               -- lo arma Moodle; no es firstname + lastname
      siteurl                TEXT NOT NULL,      -- CON subruta; de acá cuelga cada endpoint
      siteid                 INTEGER NOT NULL,
      sitename               TEXT,
      release                TEXT NOT NULL,      -- texto libre, solo para mostrar
      version                TEXT NOT NULL,      -- sello YYYYMMDDXX, lo único comparable
      lang                   TEXT NOT NULL,
      theme                  TEXT,
      userpictureurl         TEXT,
      picture_needs_token    INTEGER NOT NULL DEFAULT 0,  -- 1 solo si la ruta es /webservice/pluginfile.php
      mobilecssurl           TEXT,               -- puede ser cadena vacía, no null
      userhomepage           INTEGER,
      downloadfiles          INTEGER NOT NULL,
      uploadfiles            INTEGER NOT NULL,
      usercanmanageownfiles  INTEGER NOT NULL,   -- llega booleano JSON, se guarda 0/1
      userquota              INTEGER,            -- bytes, cuota total
      usermaxuploadfilesize  INTEGER,            -- bytes por archivo; independiente de la cuota
      userissiteadmin        INTEGER NOT NULL DEFAULT 0,
      policyagreed           INTEGER NOT NULL DEFAULT 0,
      limitconcurrentlogins  INTEGER,            -- 1 acá: el sync no puede paralelizar
      usersessionscount      INTEGER,
      sitecalendartype       TEXT,
      usercalendartype       TEXT,
      functions_hash         TEXT NOT NULL,      -- sha256 de "name:version" ordenado: el delta del catálogo
      fetched_at             TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- userprivateaccesskey NO se guarda acá a propósito: es una credencial que da
    -- acceso al calendario y a tokenpluginfile.php sin sesión. Va al credentialStore
    -- junto al wstoken, con el mismo modo 600, y nunca se loguea.

    -- El catálogo tal como lo ve ESE token. Se consulta antes de programar
    -- cualquier llamada: si el nombre no está, la rama del sync no se intenta y no
    -- cuenta como error, sino como capability ausente.
    CREATE TABLE IF NOT EXISTS pva_functions (
      user_id        INTEGER NOT NULL,
      name           TEXT NOT NULL,
      version        TEXT NOT NULL,              -- versión del COMPONENTE, no del sitio
      area           TEXT NOT NULL,              -- identidad|cursos|tareas|notas|calendario|foros|mensajes|archivos|modulos
      writes         INTEGER NOT NULL DEFAULT 0, -- 1 si muta estado en la plataforma
      first_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
      gone_at        TEXT,                       -- dejó de aparecer tras un upgrade del sitio
      PRIMARY KEY (user_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_pva_functions_area
      ON pva_functions(user_id, area) WHERE gone_at IS NULL;

    -- Configuración del sitio: tool_mobile_get_config y los advancedfeatures de
    -- site_info viven juntos porque se leen juntos. Sin user_id: es del sitio, no
    -- de la persona. value siempre TEXT porque el WS mezcla "1" con 1.
    CREATE TABLE IF NOT EXISTS pva_site_config (
      source      TEXT NOT NULL,                 -- 'mobile_config' | 'advanced_feature'
      name        TEXT NOT NULL,
      value       TEXT,                          -- cadena vacía y NULL son estados distintos
      is_numeric  INTEGER NOT NULL DEFAULT 0,    -- 1 si el JSON lo mandó sin comillas
      fetched_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (source, name)
    );

    -- La materia matriculada. El mapa documenta los campos de
    -- core_enrol_get_users_courses pero no define la tabla: esta se deriva de los
    -- 29 campos observados, y se queda con los que gobiernan el resto del dominio.
    --   * hidden es el ÚNICO filtro del ciclo activo. La ventana startdate/enddate
    --     deja fuera materias con contenido reciente y entregas sin corregir.
    --   * timemodified NO sirve de watermark: el contenido es más nuevo que él.
    --   * courseimage no se guarda: es un data URI que pesa el 75% de la respuesta.
    CREATE TABLE IF NOT EXISTS pva_course (
      course_id       INTEGER NOT NULL,
      user_id         INTEGER NOT NULL,
      shortname       TEXT    NOT NULL,
      fullname        TEXT    NOT NULL,
      displayname     TEXT,
      idnumber        TEXT,
      category_id     INTEGER,
      summary_html    TEXT    NOT NULL DEFAULT '',
      summary_format  INTEGER NOT NULL DEFAULT 1,
      format          TEXT,                          -- tiles|buttons|topics|...
      lang            TEXT    NOT NULL DEFAULT '',   -- '' = hereda del sitio
      startdate       INTEGER,                       -- NULL cuando llegó 0
      enddate         INTEGER,
      visible         INTEGER NOT NULL DEFAULT 1,
      hidden          INTEGER NOT NULL DEFAULT 0,    -- el filtro del ciclo activo
      show_grades     INTEGER NOT NULL DEFAULT 1,    -- precondición del libro
      enable_completion INTEGER NOT NULL DEFAULT 0,  -- no implica completiondata por módulo
      completion_tracked INTEGER NOT NULL DEFAULT 0,
      progress        REAL,                          -- NULL en cursos sin seguimiento
      completed       INTEGER,                       -- tri-estado: llega null
      last_access     INTEGER,
      enrolled_users  INTEGER,
      is_favourite    INTEGER NOT NULL DEFAULT 0,
      remote_timemodified INTEGER,                   -- inservible como watermark
      first_seen_at   INTEGER NOT NULL,
      last_seen_at    INTEGER NOT NULL,
      missing_since   INTEGER,                       -- dejó de venir: se marca, no se borra
      PRIMARY KEY (user_id, course_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pva_course_activas
      ON pva_course (user_id) WHERE hidden = 0 AND missing_since IS NULL;

    -- Un bloque de la página del curso. id es la identidad; section_number es
    -- la posición y cambia si el profesor reordena. sort_index guarda el índice
    -- del array porque la respuesta no trae ningún campo de orden.
    CREATE TABLE IF NOT EXISTS pva_course_section (
      section_id        INTEGER PRIMARY KEY,          -- sections[].id
      user_id           INTEGER NOT NULL,
      course_id         INTEGER NOT NULL,
      section_number    INTEGER NOT NULL,             -- sections[].section, 0 = cabecera
      name              TEXT NOT NULL DEFAULT '',     -- puede traer entidades HTML sin decodificar
      summary_html      TEXT NOT NULL DEFAULT '',     -- HTML con style= inline y URLs pluginfile
      summary_format    INTEGER NOT NULL DEFAULT 1,
      visible           INTEGER NOT NULL DEFAULT 1,
      uservisible       INTEGER NOT NULL DEFAULT 1,
      hidden_by_numsecs INTEGER NOT NULL DEFAULT 0,
      component         TEXT,                         -- null en todo el volcado
      item_id           INTEGER,                      -- null en todo el volcado
      sort_index        INTEGER NOT NULL,             -- índice en el array de la respuesta
      seen_at           TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pva_section_course
      ON pva_course_section (user_id, course_id, sort_index);

    -- Un módulo de la página. cmid es LA identidad entre sincronizaciones.
    --   * url es NULL en los label y solo en los label; no_view_link dice lo
    --     mismo de forma explícita y es el discriminador que hay que usar.
    --   * completion_state es NULL cuando completion_rule = 0, y eso depende del
    --     módulo, no del curso.
    --   * customdata_json se guarda CRUDO: adentro conviven tipos distintos para
    --     el mismo nombre de campo y un valor serializado por PHP. Normalizarlo al
    --     guardar sería inventar.
    CREATE TABLE IF NOT EXISTS pva_module (
      cmid                INTEGER PRIMARY KEY,        -- modules[].id
      user_id             INTEGER NOT NULL,
      course_id           INTEGER NOT NULL,
      section_id          INTEGER NOT NULL REFERENCES pva_course_section(section_id) ON DELETE CASCADE,
      sort_index          INTEGER NOT NULL,           -- índice dentro de modules[]
      modname             TEXT NOT NULL,              -- url|resource|assign|label|page|folder|forum|glossary|...
      instance            INTEGER NOT NULL,
      context_id          INTEGER NOT NULL,           -- aparece en la ruta de los fileurl
      name                TEXT NOT NULL,
      url                 TEXT,                       -- NULL en label
      description_html    TEXT,                       -- NULL cuando la clave no vino; '' cuando vino vacía
      visible             INTEGER NOT NULL DEFAULT 1,
      uservisible         INTEGER NOT NULL DEFAULT 1,
      visible_on_page     INTEGER NOT NULL DEFAULT 1,
      no_view_link        INTEGER NOT NULL DEFAULT 0, -- 1 = se pinta, no se abre
      can_display         INTEGER NOT NULL DEFAULT 1,
      purpose             TEXT,                       -- content|assessment|collaboration
      indent              INTEGER NOT NULL DEFAULT 0,
      group_mode          INTEGER NOT NULL DEFAULT 0,
      download_content    INTEGER NOT NULL DEFAULT 1,
      icon_url            TEXT,                       -- depende del contenido, no del modname
      completion_rule     INTEGER NOT NULL DEFAULT 0, -- 0 sin seguimiento, 1 manual
      completion_state    INTEGER,                    -- NULL si completion_rule = 0
      completed_at        INTEGER,                    -- epoch; 0 es el centinela de "no completado"
      completion_override_by INTEGER,
      completion_automatic   INTEGER,
      completion_tracked     INTEGER,
      customdata_json     TEXT,                       -- crudo: string JSON, o el literal ""
      content_hash        TEXT,                       -- sha256 del subárbol, para el delta local
      seen_at             TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pva_module_section
      ON pva_module (user_id, section_id, sort_index);
    CREATE INDEX IF NOT EXISTS idx_pva_module_kind
      ON pva_module (user_id, course_id, modname);
    -- La pareja que necesitan mod_assign, mod_forum y los demás lectores. En el
    -- volcado instance salió único por sí solo, pero la clave del modelo de
    -- Moodle es la pareja.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pva_module_instance
      ON pva_module (modname, instance);

    -- Las fechas que la PVA muestra bajo un módulo. Tabla aparte porque el array
    -- trae 0, 1 o 2 elementos. La clave es data_id, NUNCA label, que viene
    -- traducido al idioma del curso. En el volcado ningún cmid repitió data_id; si
    -- algún día se repite, esta PK pierde la segunda fecha.
    CREATE TABLE IF NOT EXISTS pva_module_date (
      cmid       INTEGER NOT NULL REFERENCES pva_module(cmid) ON DELETE CASCADE,
      data_id    TEXT NOT NULL,                       -- duedate | allowsubmissionsfromdate
      ts         INTEGER NOT NULL,                    -- epoch en segundos
      label      TEXT,                                -- localizado, solo para mostrar
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (cmid, data_id)
    );

    -- El reloj del sync por curso. hash_tree permite descartar una respuesta
    -- entera sin recorrerla.
    CREATE TABLE IF NOT EXISTS pva_course_sync (
      user_id        INTEGER NOT NULL,
      course_id      INTEGER NOT NULL,
      contents_at    TEXT,                            -- ISO del último get_contents ok
      server_since   INTEGER,                         -- epoch enviado en el último delta
      hash_tree      TEXT,                            -- sha256 de la respuesta normalizada
      sections       INTEGER,
      modules        INTEGER,
      last_error     TEXT,
      updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, course_id)
    );

    -- Regla de fechas: el 0 que manda Moodle NO es 1970, es "no hay fecha". Se
    -- normaliza a NULL al escribir y se vuelve a 0 solo si algo se manda de regreso.
    CREATE TABLE IF NOT EXISTS pva_assignment (
      assignment_id              INTEGER PRIMARY KEY,        -- assign.id
      user_id                    INTEGER NOT NULL,
      cmid                       INTEGER NOT NULL UNIQUE,    -- join con módulos, grade items y calendario
      course_id                  INTEGER NOT NULL,
      name                       TEXT    NOT NULL,
      intro_html                 TEXT    NOT NULL DEFAULT '',
      intro_format               INTEGER NOT NULL DEFAULT 1,
      duedate                    INTEGER,                    -- NULL = sin fecha límite
      allowsubmissionsfromdate   INTEGER,                    -- NULL = abierta desde siempre
      cutoffdate                 INTEGER,                    -- NULL = acepta tarde sin límite
      gradingduedate             INTEGER,
      timelimit_s                INTEGER NOT NULL DEFAULT 0,
      grade_max                  INTEGER NOT NULL DEFAULT 0, -- >0 puntaje; 0 sin calificación; <0 = -scaleid
      nosubmissions              INTEGER NOT NULL DEFAULT 0,
      submissiondrafts           INTEGER NOT NULL DEFAULT 0, -- 0 = no existe etapa de borrador
      requiresubmissionstatement INTEGER NOT NULL DEFAULT 0,
      attemptreopenmethod        TEXT    NOT NULL DEFAULT 'none',
      maxattempts                INTEGER NOT NULL DEFAULT 1, -- 1 en las 17 observadas
      completionsubmit           INTEGER NOT NULL DEFAULT 0,
      teamsubmission             INTEGER NOT NULL DEFAULT 0,
      blindmarking               INTEGER NOT NULL DEFAULT 0,
      markingworkflow            INTEGER NOT NULL DEFAULT 0, -- 1 = la nota puede existir y no verse
      gradepenalty               INTEGER NOT NULL DEFAULT 0,
      sendstudentnotifications   INTEGER NOT NULL DEFAULT 1,
      remote_timemodified        INTEGER NOT NULL,           -- detector de cambio del servidor
      fetched_at                 INTEGER NOT NULL,
      CHECK (attemptreopenmethod IN ('none','manual','untilpass')),
      CHECK (duedate    IS NULL OR duedate    > 0),
      CHECK (cutoffdate IS NULL OR cutoffdate > 0)
    );
    CREATE INDEX IF NOT EXISTS idx_pva_assignment_course ON pva_assignment(user_id, course_id);
    -- El índice parcial deja fuera las de duedate NULL, que nunca entran en una
    -- vista de "próximas entregas".
    CREATE INDEX IF NOT EXISTS idx_pva_assignment_due
      ON pva_assignment(duedate) WHERE duedate IS NOT NULL;

    -- configs[] aplanado tal cual llega. value es TEXT porque el servidor manda
    -- TODO como string. La ausencia de una fila es tan informativa como
    -- enabled='0': onlinetext no aparece en ninguna tarea.
    CREATE TABLE IF NOT EXISTS pva_assignment_config (
      assignment_id INTEGER NOT NULL REFERENCES pva_assignment(assignment_id) ON DELETE CASCADE,
      subtype       TEXT NOT NULL,   -- assignsubmission | assignfeedback
      plugin        TEXT NOT NULL,   -- file | comments | editpdf
      name          TEXT NOT NULL,
      value         TEXT NOT NULL,
      PRIMARY KEY (assignment_id, subtype, plugin, name)
    );

    -- Tareas que el servidor dice que existen pero el estudiante no puede ver.
    -- Su cmid NO aparece en el contenido visible, así que no hay a qué unirlo.
    CREATE TABLE IF NOT EXISTS pva_assignment_inaccessible (
      user_id     INTEGER NOT NULL,
      course_id   INTEGER NOT NULL,
      cmid        INTEGER NOT NULL,
      warningcode TEXT    NOT NULL,   -- '1' llega como string
      message     TEXT    NOT NULL,   -- copy del servidor, no parsear
      fetched_at  INTEGER NOT NULL,
      PRIMARY KEY (user_id, course_id, cmid)
    );

    -- El intento vigente. Si algún día aparece previousattempts, entra acá con
    -- is_latest = 0.
    CREATE TABLE IF NOT EXISTS pva_submission (
      assignment_id       INTEGER NOT NULL REFERENCES pva_assignment(assignment_id) ON DELETE CASCADE,
      attemptnumber       INTEGER NOT NULL,          -- base 0
      submission_id       INTEGER,                   -- NULL si el intento no existe todavía
      user_id             INTEGER NOT NULL,
      status              TEXT    NOT NULL,          -- new|draft|submitted|reopened
      is_latest           INTEGER NOT NULL DEFAULT 1,
      group_id            INTEGER NOT NULL DEFAULT 0,
      timecreated         INTEGER,
      timemodified        INTEGER,                   -- se compara contra duedate para el atraso
      timestarted         INTEGER,                   -- NULL salvo con cronómetro
      submissions_enabled INTEGER NOT NULL DEFAULT 1,
      locked              INTEGER NOT NULL DEFAULT 0,
      graded              INTEGER NOT NULL DEFAULT 0,
      can_edit            INTEGER NOT NULL DEFAULT 0,
      can_edit_owner      INTEGER NOT NULL DEFAULT 0,
      can_submit          INTEGER NOT NULL DEFAULT 0,
      grading_status      TEXT    NOT NULL,          -- graded|notgraded|estados de markingworkflow
      extensionduedate    INTEGER,                   -- llega 0 o null; ambos = sin prórroga -> NULL
      timelimit_s         INTEGER NOT NULL DEFAULT 0,
      blindmarking        INTEGER NOT NULL DEFAULT 0,
      fetched_at          INTEGER NOT NULL,
      PRIMARY KEY (assignment_id, attemptnumber),
      CHECK (status IN ('new','draft','submitted','reopened')),
      CHECK (extensionduedate IS NULL OR extensionduedate > 0)
    );
    CREATE INDEX IF NOT EXISTS idx_pva_submission_status
      ON pva_submission(status, grading_status);

    -- La nota. Fila que solo existe cuando la respuesta trae la clave 'feedback'.
    CREATE TABLE IF NOT EXISTS pva_submission_feedback (
      assignment_id     INTEGER NOT NULL,
      attemptnumber     INTEGER NOT NULL,
      grade_id          INTEGER,
      grade_value       REAL,      -- parseado del string
      grade_raw_text    TEXT,      -- el string original: no pierde precisión ni el '-1.00000'
      grade_for_display TEXT,      -- HTML con entidades; solo para mostrar, nunca para calcular
      graded_date       INTEGER,
      grader_user_id    INTEGER,
      timecreated       INTEGER,
      timemodified      INTEGER,
      comment_html      TEXT,      -- plugins[type='comments'].editorfields[name='comments'].text
      comment_format    INTEGER,
      PRIMARY KEY (assignment_id, attemptnumber),
      FOREIGN KEY (assignment_id, attemptnumber)
        REFERENCES pva_submission(assignment_id, attemptnumber) ON DELETE CASCADE
    );

    -- Un renglón por item del libro. Sobrevive a que el item desaparezca del payload.
    CREATE TABLE IF NOT EXISTS pva_grade_item (
      item_id        INTEGER PRIMARY KEY,            -- gradeitems[].id, PK global de Moodle
      user_id        INTEGER NOT NULL,
      course_id      INTEGER NOT NULL,
      itemtype       TEXT    NOT NULL
                     CHECK (itemtype IN ('mod','course','category','manual','outcome')),
      itemmodule     TEXT,                           -- 'assign' visto; NULL fuera de itemtype='mod'
      iteminstance   INTEGER NOT NULL,               -- id del módulo si 'mod'; id de grade_category si no
      itemnumber     INTEGER,
      cmid           INTEGER,                        -- la clave NO viene en itemtype='course'
      category_id    INTEGER,                        -- padre; NULL en el total del curso
      idnumber       TEXT,
      itemname       TEXT,                           -- NULL en 'course'/'category': la etiqueta la pone la app
      grademin       REAL    NOT NULL,
      grademax       REAL    NOT NULL,               -- puede quedar en 100 aunque el item no califique
      scaleid        INTEGER,
      outcomeid      INTEGER,
      locked         INTEGER,                        -- tri-estado 0/1/NULL
      sort_index     INTEGER NOT NULL,               -- índice en el array: el orden del profesor
      is_gradable    INTEGER NOT NULL DEFAULT 1,     -- 0 si rangeformatted no trae dígitos o grademax = 0
      first_seen_at  INTEGER NOT NULL,
      last_seen_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pva_grade_item_course ON pva_grade_item (user_id, course_id, sort_index);
    CREATE INDEX IF NOT EXISTS idx_pva_grade_item_cmid   ON pva_grade_item (cmid) WHERE cmid IS NOT NULL;
    -- El padre de un item se resuelve por (course_id, iteminstance) del item de categoría.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pva_grade_item_cat
      ON pva_grade_item (course_id, iteminstance) WHERE itemtype IN ('course','category');

    -- Estado actual de la nota. Separado del item porque cambia con otro ritmo.
    CREATE TABLE IF NOT EXISTS pva_grade_value (
      item_id             INTEGER PRIMARY KEY REFERENCES pva_grade_item(item_id) ON DELETE CASCADE,
      graderaw            REAL,                      -- NULL = sin nota
      graderaw_src        TEXT,                      -- el valor tal como llegó, para comparar sin drift de float
      gradedatesubmitted  INTEGER,                   -- entregó el ESTUDIANTE. NO es señal de calificación
      gradedategraded     INTEGER,                   -- calificó el PROFESOR. Ésta sí lo es
      grade_display       TEXT NOT NULL,             -- gradeformatted crudo, entidades incluidas
      percentage_display  TEXT NOT NULL,
      range_display       TEXT NOT NULL,
      feedback_html       TEXT NOT NULL DEFAULT '',
      feedback_format     INTEGER NOT NULL DEFAULT 0,
      is_hidden           INTEGER NOT NULL DEFAULT 0,
      hidden_by_date      INTEGER NOT NULL DEFAULT 0,
      needs_update        INTEGER NOT NULL DEFAULT 0,
      is_locked           INTEGER,                   -- tri-estado
      is_overridden       INTEGER,                   -- tri-estado
      fetched_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pva_grade_value_graded
      ON pva_grade_value (gradedategraded) WHERE gradedategraded IS NOT NULL;

    -- Bitácora de cambios: evita notificar dos veces y permite mostrar "qué cambió
    -- desde la última vez que abriste".
    CREATE TABLE IF NOT EXISTS pva_grade_change (
      change_id       INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id         INTEGER NOT NULL REFERENCES pva_grade_item(item_id) ON DELETE CASCADE,
      kind            TEXT    NOT NULL
                      CHECK (kind IN ('published','regraded','unhidden','removed','total_moved')),
      old_raw_src     TEXT,
      new_raw_src     TEXT,
      old_graded_at   INTEGER,
      new_graded_at   INTEGER,
      detected_at     INTEGER NOT NULL,
      notified_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_pva_grade_change_pending
      ON pva_grade_change (detected_at) WHERE notified_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pva_grade_change_fact
      ON pva_grade_change (item_id, kind, COALESCE(new_graded_at,-1), COALESCE(new_raw_src,''));

    -- Total por curso. Vive aparte porque una sola llamada la llena entera y llega
    -- antes que el detalle.
    CREATE TABLE IF NOT EXISTS pva_course_total (
      user_id        INTEGER NOT NULL,
      course_id      INTEGER NOT NULL,
      grade_display  TEXT NOT NULL,                  -- '-' o el número redondeado a 2 decimales
      rawgrade_src   TEXT,                           -- 5 decimales, en texto: es lo que se compara
      rawgrade       REAL,                           -- derivado, solo para cálculos
      fetched_at     INTEGER NOT NULL,
      PRIMARY KEY (user_id, course_id)
    );

    -- Por qué un curso no tiene libro. Sin esto el fallback no sabe a quién aplicarse.
    CREATE TABLE IF NOT EXISTS pva_gradebook_access (
      user_id        INTEGER NOT NULL,
      course_id      INTEGER NOT NULL,
      show_grades    INTEGER NOT NULL,               -- core_enrol_get_users_courses.showgrades
      reachable      INTEGER NOT NULL,               -- 0 si la última llamada lanzó excepción
      last_errorcode TEXT,                           -- 'nopermissiontoviewgrades'
      last_ok_at     INTEGER,
      last_try_at    INTEGER NOT NULL,
      in_overview    INTEGER NOT NULL DEFAULT 0,     -- apareció en el overview
      PRIMARY KEY (user_id, course_id)
    );

    -- Una fila por evento del feed de acciones. No se guardan los campos
    -- localizados re-derivables (formattedtime, normalisedeventtypetext) ni las
    -- URLs con sesskey (editurl, deleteurl) ni course.courseimage.
    CREATE TABLE IF NOT EXISTS pva_calendar_event (
      event_id             INTEGER PRIMARY KEY,
      user_id              INTEGER NOT NULL,
      course_id            INTEGER NOT NULL,
      cmid                 INTEGER,                      -- events[].instance: ES el course module id
      component            TEXT,                         -- 'mod_assign'
      modulename           TEXT,                         -- 'assign'
      eventtype            TEXT NOT NULL,                -- 'due'
      normalised_eventtype TEXT NOT NULL,                -- 'course'
      name                 TEXT NOT NULL,                -- cadena guardada, no derivable de activityname
      activityname         TEXT,                         -- el título que pinta la UI
      activitystr          TEXT,                         -- localizado, solo para pintar
      description_html     TEXT NOT NULL DEFAULT '',
      description_format   INTEGER NOT NULL DEFAULT 1,   -- 1 = HTML aun con description vacía
      location             TEXT NOT NULL DEFAULT '',
      timestart            INTEGER NOT NULL,
      timesort             INTEGER NOT NULL,             -- clave de orden y de paginación
      timeduration         INTEGER NOT NULL DEFAULT 0,
      timeusermidnight     INTEGER NOT NULL,             -- medianoche local del día del evento
      timemodified         INTEGER NOT NULL,
      visible              INTEGER NOT NULL DEFAULT 1,
      overdue              INTEGER NOT NULL DEFAULT 0,
      is_action_event      INTEGER NOT NULL DEFAULT 0,
      is_course_event      INTEGER NOT NULL DEFAULT 0,
      is_category_event    INTEGER NOT NULL DEFAULT 0,
      category_id          INTEGER,                      -- null en todo el volcado
      group_id             INTEGER,
      event_userid         INTEGER,                      -- events[].userid, renombrado para no chocar
      repeat_id            INTEGER,
      event_count          INTEGER,
      purpose              TEXT,                         -- 'assessment': taxonomía, no prioridad
      icon_key             TEXT,                         -- icon_key + icon_component es la pareja estable
      icon_component       TEXT,
      action_name          TEXT,                         -- localizado
      action_url           TEXT,
      action_itemcount     INTEGER,
      action_actionable    INTEGER NOT NULL DEFAULT 0,   -- "se puede actuar ahora", no "está pendiente"
      module_url           TEXT,                         -- events[].url
      calendar_view_url    TEXT,                         -- events[].viewurl, vista de día
      source               TEXT NOT NULL DEFAULT 'action_timesort',
      payload_hash         TEXT NOT NULL,                -- sin courseimage
      first_seen_at        INTEGER NOT NULL,
      last_seen_at         INTEGER NOT NULL,
      missing_since        INTEGER,                      -- desapareció del feed: ambiguo, nunca borrar en caliente
      -- El día local sale de la medianoche que Moodle ya calculó en la zona del
      -- usuario, sin necesidad de una base de zonas horarias en el cliente.
      local_day TEXT GENERATED ALWAYS AS (date(timeusermidnight + 43200, 'unixepoch')) VIRTUAL
    );
    CREATE INDEX IF NOT EXISTS idx_pva_event_timesort  ON pva_calendar_event(timesort);
    CREATE INDEX IF NOT EXISTS idx_pva_event_course    ON pva_calendar_event(course_id, timesort);
    CREATE INDEX IF NOT EXISTS idx_pva_event_cmid      ON pva_calendar_event(cmid);
    CREATE INDEX IF NOT EXISTS idx_pva_event_local_day ON pva_calendar_event(local_day);
    CREATE INDEX IF NOT EXISTS idx_pva_event_pendiente ON pva_calendar_event(missing_since, timesort);

    CREATE TABLE IF NOT EXISTS pva_forum (
      forum_id               INTEGER PRIMARY KEY,          -- instancia del foro
      user_id                INTEGER NOT NULL,
      course_id              INTEGER NOT NULL,
      cmid                   INTEGER NOT NULL UNIQUE,
      type                   TEXT    NOT NULL,             -- 'news' | 'general' | ...
      is_announcements       INTEGER GENERATED ALWAYS AS (type = 'news') VIRTUAL,
      name                   TEXT    NOT NULL,             -- rótulo, nunca criterio
      intro_html             TEXT,
      forcesubscribe         INTEGER NOT NULL DEFAULT 0,
      trackingtype           INTEGER NOT NULL DEFAULT 0,
      is_tracked             INTEGER NOT NULL DEFAULT 0,
      can_create_discussions INTEGER NOT NULL DEFAULT 0,   -- NO discrimina anuncios
      num_discussions        INTEGER NOT NULL DEFAULT 0,   -- guarda de delta para anuncios
      duedate                INTEGER NOT NULL DEFAULT 0,   -- 0 = sin fecha; >0 = entrega que mod_assign no reporta
      cutoffdate             INTEGER NOT NULL DEFAULT 0,   -- puede ser igual a duedate
      scale                  INTEGER NOT NULL DEFAULT 0,   -- escala de valoraciones; inerte si assessed = 0
      assessed               INTEGER NOT NULL DEFAULT 0,   -- != 0 es lo que hace calificable al foro
      grade_forum            INTEGER NOT NULL DEFAULT 0,
      config_modified_at     INTEGER NOT NULL DEFAULT 0,   -- timemodified: CONFIG, no último post
      fetched_at             INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pva_forum_course     ON pva_forum (user_id, course_id);
    CREATE INDEX IF NOT EXISTS idx_pva_forum_anuncios   ON pva_forum (user_id, course_id) WHERE type = 'news';
    CREATE INDEX IF NOT EXISTS idx_pva_forum_entregable ON pva_forum (duedate) WHERE duedate > 0;

    -- Campanita. Insert-only con ON CONFLICT(id) DO UPDATE de read/timeread/deleted.
    CREATE TABLE IF NOT EXISTS pva_notification (
      notification_id    INTEGER PRIMARY KEY,     -- id de Moodle, estable
      user_id            INTEGER NOT NULL,
      userid_from        INTEGER NOT NULL,        -- puede ser NEGATIVO (sistema). Sin FK
      component          TEXT    NOT NULL,        -- 'mod_assign', 'mod_forum', ...
      eventtype          TEXT    NOT NULL,        -- 'assign_due_soon', ...
      subject            TEXT    NOT NULL,
      small_message      TEXT,
      full_message_html  TEXT,
      contexturl         TEXT,
      contexturl_name    TEXT,
      cmid               INTEGER,                 -- derivado de contexturl ?id=<cmid>
      course_id          INTEGER,                 -- NULL hasta resolver cmid; puede quedar NULL
      customdata_raw     TEXT,                    -- string JSON crudo, puede venir NULL o ''
      instance_id        INTEGER,                 -- customdata.assignmentid: NO es el cmid
      customdata_duedate INTEGER,
      icon_url           TEXT,
      created_at         INTEGER NOT NULL,        -- timecreated, marca de agua del pull
      read_remote        INTEGER NOT NULL DEFAULT 0, -- estado COMPARTIDO con el portal
      read_at_remote     INTEGER,
      deleted_remote     INTEGER NOT NULL DEFAULT 0,
      fetched_at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pva_notif_ruteo   ON pva_notification (component, eventtype, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pva_notif_cmid    ON pva_notification (cmid) WHERE cmid IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_pva_notif_sinruta ON pva_notification (notification_id) WHERE course_id IS NULL;


  `);
}


/**
 * Los archivos del aula. Cinco tablas, migración 15, aditiva como la anterior.
 *
 * El SQL sale del mapa y lo que sostiene es una decisión que no es obvia: la
 * identidad de un archivo NO es su URL. En mod_resource la ruta lleva un
 * número de revisión que cambia cuando el profesor reemplaza el fichero, así
 * que un UNIQUE sobre la URL crearía una fila nueva en cada reemplazo en vez de
 * actualizar la que ya estaba. La clave es dónde vive el archivo:
 * (curso, cmid, componente, área, ruta, nombre).
 *
 * Las otras tres que se ven en el esquema:
 *   * La metadata y el blob viven separados porque caducan distinto: la
 *     metadata por TTL, el blob solo cuando cambia el ETag, que es la única
 *     señal fiable (timemodified es la fecha de la restauración del curso y 29
 *     de 54 ficheros la comparten al minuto).
 *   * Un contents[] con type='url' no es un archivo: no tiene tamaño, ni tipo,
 *     ni ruta. Vive en pva_link para que ninguna consulta de bytes lo toque, y
 *     sobre todo para que nadie le mande el token a un host de terceros.
 *   * El texto extraído se indexa en FTS5 con el file_id como rowid, así una
 *     búsqueda vuelve directo a su archivo sin una tabla puente.
 */
export function createPvaFileTables(db) {
  db.exec(`
    -- Un archivo tal como lo describe la PVA. La identidad NO es la URL: en
    -- mod_resource la ruta lleva un número de revisión que cambia cuando el
    -- profesor reemplaza el fichero, y un UNIQUE sobre la URL crearía una fila
    -- nueva en cada reemplazo en vez de actualizar la existente.
    CREATE TABLE IF NOT EXISTS pva_file (
      file_id        INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER NOT NULL,
      course_id      INTEGER NOT NULL,
      cmid           INTEGER NOT NULL DEFAULT 0,   -- 0 para overviewfiles del curso
      context_id     INTEGER NOT NULL,
      component      TEXT    NOT NULL,             -- mod_resource|mod_page|mod_folder|mod_assign|assignsubmission_file|assignfeedback_editpdf|course
      area           TEXT    NOT NULL,             -- content|introattachment|submission_files|combined|overviewfiles|...
      item_id        INTEGER,                      -- NULL en mod_page/content y course/overviewfiles: la URL corta no lo trae
      revision       INTEGER,                      -- 4o segmento en mod_resource; cambia al reemplazar el fichero
      filepath       TEXT    NOT NULL DEFAULT '/',
      filename       TEXT    NOT NULL,             -- decodificado; el último segmento de fileurl viene percent-encoded
      fileurl        TEXT    NOT NULL,             -- sin token y sin query
      force_download INTEGER NOT NULL DEFAULT 0,   -- 1 si la fileurl original ya traía query
      filesize       INTEGER NOT NULL DEFAULT 0,   -- DECLARADO. 0 no significa vacío: mod_page reporta 0 con cuerpo real
      mimetype       TEXT,                         -- NULL en mod_page y en type='url'
      isexternalfile INTEGER,                      -- NULL cuando la función de origen no trae la clave
      timecreated    INTEGER,                      -- solo core_course_get_contents lo trae, y no siempre
      timemodified   INTEGER NOT NULL,
      sortorder      INTEGER,
      license        TEXT,
      source_fn      TEXT    NOT NULL,             -- wsfunction que lo trajo
      seen_at        INTEGER NOT NULL,
      deleted_at     INTEGER,                      -- soft delete; el profesor puede reponerlo
      UNIQUE (course_id, cmid, component, area, filepath, filename)
    );
    -- contents[].author y contents[].userid NO se guardan: son nombres e ids de
    -- profesores reales y ninguna pantalla los usa. Si algún día hace falta
    -- mostrar autoría, se agrega la columna con la justificación en el mismo commit.
    CREATE INDEX IF NOT EXISTS idx_pva_file_course ON pva_file (user_id, course_id, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_pva_file_cmid   ON pva_file (cmid);
    CREATE INDEX IF NOT EXISTS idx_pva_file_mime   ON pva_file (mimetype);

    -- Estado del blob en disco, separado de la metadata porque caduca distinto: la
    -- metadata por TTL, el blob solo cuando el ETag cambia.
    CREATE TABLE IF NOT EXISTS pva_file_blob (
      file_id       INTEGER PRIMARY KEY REFERENCES pva_file(file_id) ON DELETE CASCADE,
      local_path    TEXT    NOT NULL,              -- <cache>/<course_id>/<cmid>/<sha256[:2]>/<sha256>
      bytes         INTEGER NOT NULL,              -- reales, contados al escribir; no filesize
      sha256        TEXT    NOT NULL,
      etag          TEXT,                          -- tal cual, con comillas, para If-None-Match
      last_modified TEXT,                          -- string HTTP tal cual, para If-Modified-Since
      content_type  TEXT,                          -- el real; manda sobre pva_file.mimetype
      downloaded_at INTEGER NOT NULL,
      verified_at   INTEGER NOT NULL,              -- último 304 o 200
      attempts      INTEGER NOT NULL DEFAULT 0,
      last_error    TEXT
    );

    -- Texto extraído. Un archivo puede fallar la extracción sin invalidar el blob,
    -- y reextraer se decide comparando sha256, no fechas.
    CREATE TABLE IF NOT EXISTS pva_file_text (
      file_id     INTEGER PRIMARY KEY REFERENCES pva_file(file_id) ON DELETE CASCADE,
      sha256      TEXT    NOT NULL,                -- del blob del que salió
      extractor   TEXT    NOT NULL,                -- pdf|docx|pptx|doc|html|ocr
      pages       INTEGER,
      -- El nombre se copia acá porque el índice FTS de abajo es de contenido
      -- externo y lo declara como columna: sin esta, FTS5 no puede releer sus
      -- propias filas y un rebuild o un delete quedan rotos. El mapa lo indexa
      -- sin tenerlo en la tabla; esta columna es la corrección.
      filename    TEXT    NOT NULL DEFAULT '',
      content     TEXT    NOT NULL,
      extracted_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS pva_file_text_fts USING fts5(
      filename, content,
      content='pva_file_text', content_rowid='file_id',
      tokenize="unicode61 remove_diacritics 2"
    );

    -- contents[] con type='url' no es un archivo: no tiene filesize útil, ni
    -- mimetype, ni filepath, ni sortorder. Vive aparte para que ninguna consulta de
    -- bytes o de descarga lo toque por accidente.
    CREATE TABLE IF NOT EXISTS pva_link (
      link_id      INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL,
      course_id    INTEGER NOT NULL,
      cmid         INTEGER NOT NULL,
      name         TEXT    NOT NULL,               -- contents[].filename
      url          TEXT    NOT NULL,               -- host externo
      host         TEXT    NOT NULL,
      timemodified INTEGER NOT NULL,
      seen_at      INTEGER NOT NULL,
      UNIQUE (cmid, url)
    );

    -- Resumen por módulo: sirve para decidir si vale la pena abrirlo.
    CREATE TABLE IF NOT EXISTS pva_module_contents_info (
      cmid            INTEGER PRIMARY KEY REFERENCES pva_module(cmid) ON DELETE CASCADE,
      files_count     INTEGER NOT NULL DEFAULT 0,
      files_size      INTEGER NOT NULL DEFAULT 0,  -- 0 en page y url aunque haya archivo
      last_modified   INTEGER NOT NULL DEFAULT 0,  -- el mejor watermark por módulo
      mime_types_json TEXT    NOT NULL DEFAULT '[]',
      repository_type TEXT,                        -- '' local; CLAVE AUSENTE cuando files_count = 0
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
}


/**
 * El libro de avisos de la PVA. Se crea recién ahora, con la fase que lo llena:
 * una tabla que nadie escribe es una promesa vacía en el esquema.
 *
 * Su razón de ser es la idempotencia. `read` y `timeread` de la campanita son
 * estado COMPARTIDO con el portal web: si el estudiante abre la campanita en el
 * navegador, Moodle los mueve sin que la app se entere, así que no sirven para
 * decidir si un aviso ya se mostró. Lo único que decide eso es `delivered_at`
 * de acá.
 *
 * Y la llave de deduplicación es el OBJETO de Moodle, no la notificación: un
 * recordatorio que el sitio repite y un diff que detecta lo mismo tienen que
 * colapsar en un solo aviso.
 */
export function createPvaAlertTable(db) {
  db.exec(`
    -- Ledger local de avisos. Única verdad sobre "esto ya se le mostró al usuario":
    -- read_remote no sirve porque el portal web lo cambia por su cuenta.
    CREATE TABLE IF NOT EXISTS pva_alert (
      alert_id        INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL,
      kind            TEXT    NOT NULL CHECK (kind IN ('tarea_nueva','tarea_por_vencer','nota_publicada','anuncio')),
      source          TEXT    NOT NULL CHECK (source IN ('notification','diff')),
      subject_key     TEXT    NOT NULL,           -- 'assign:<instanceid>' | 'discussion:<id>' | 'gradeitem:<id>'
      notification_id INTEGER REFERENCES pva_notification(notification_id) ON DELETE SET NULL,
      course_id       INTEGER,
      title           TEXT    NOT NULL,
      url             TEXT,
      occurred_at     INTEGER NOT NULL,
      created_at      INTEGER NOT NULL,
      delivered_at    INTEGER,
      UNIQUE (user_id, kind, subject_key)          -- dedup por objeto de Moodle, no por notificación
    );
    CREATE INDEX IF NOT EXISTS idx_pva_alert_pendientes
      ON pva_alert (occurred_at DESC) WHERE delivered_at IS NULL;
  `);
}


/**
 * El libro de escrituras de la PVA: toda intención de escribir en la
 * plataforma, incluidas las que nunca salieron.
 *
 * Es la única fase del proyecto que no se puede deshacer, así que la tabla
 * guarda lo que hace falta para reconstruir qué se mandó sin tener que
 * creerle a nadie: el texto exacto que viajó, con qué archivos, desde dónde se
 * pidió y qué contestó el servidor. Un ensayo (`dry_run = 1`) escribe una fila
 * igual: la mitad del valor de un ensayo es poder mirarlo después.
 *
 * `preview` guarda el payload literal menos el token, que nunca entra acá ni
 * en un backup.
 */
export function createPvaWriteTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pva_write (
      write_id      INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL,
      kind          TEXT    NOT NULL CHECK (kind IN ('borrador','entrega','foro','archivo')),
      wsfunction    TEXT    NOT NULL,
      course_id     INTEGER,
      assignment_id INTEGER,
      discussion_id INTEGER,
      -- El nombre tal como se le mostró a quien confirmó: si el servidor lo
      -- cambia después, la fila sigue diciendo qué creía estar entregando.
      target_name   TEXT    NOT NULL,
      preview       TEXT    NOT NULL,           -- JSON del payload, sin token
      dry_run       INTEGER NOT NULL DEFAULT 0,
      origin        TEXT    NOT NULL CHECK (origin IN ('web','mcp','cli')),
      status        TEXT    NOT NULL CHECK (status IN ('ensayo','ok','rechazada','error')),
      errorcode     TEXT,
      response      TEXT,                        -- la respuesta literal, para el día que algo no cuadre
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pva_write_reciente ON pva_write (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pva_write_tarea
      ON pva_write (assignment_id) WHERE assignment_id IS NOT NULL;
  `);
}
