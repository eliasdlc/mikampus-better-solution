import fs from 'node:fs';
import path from 'node:path';
import { isStrmCode, cycleKey } from './shared/terms.ts';

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
];

// Las columnas que guardan el IDENTIFICADOR resuelto de un ciclo (STRM si se
// conoce, si no la etiqueta). Al fusionar dos filas del mismo ciclo, sus hijos
// se reapuntan al identificador canónico.
const RESOLVED_TERM_ID_COLUMNS = [
  ['enrollments', 'term'],
  ['sections', 'term'],
  ['plans', 'term'],
  ['goals', 'deadline_term'],
  ['enrollment_windows', 'term_code'],
  ['sync_log', 'term'],
];

// Columnas que SIEMPRE guardan la etiqueta (histórico), nunca un STRM. Al
// fusionar, se reapuntan a la etiqueta canónica, no al código.
const LABEL_ONLY_TERM_COLUMNS = [
  ['grades', 'term'],
  ['pensum', 'taken_term'],
  ['progress_items', 'term'],
];

function reassign(db, table, column, from, to) {
  if (from == null || from === to) return;
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
