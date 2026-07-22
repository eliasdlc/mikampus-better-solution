import fs from 'node:fs';
import path from 'node:path';

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
];

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
