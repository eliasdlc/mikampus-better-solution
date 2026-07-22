// El esquema versionado: adopción de bases viejas, migración transaccional,
// copia pre-upgrade, recuperación ante fallo y compatibilidad declarada.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BASELINE_VERSION,
  MIGRATIONS,
  SCHEMA_VERSION,
  MigrationFailedError,
  SchemaTooNewError,
  minCompatibleVersion,
  runMigrations,
} from '../src/migrations.js';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-migrations-'));
const backupDir = path.join(dir, 'backups');

function freshDb(name) {
  return new DatabaseSync(path.join(dir, name));
}

try {
  // ── Una base nueva llega a la versión actual sin copia pre-upgrade ────────
  const nueva = freshDb('nueva.db');
  const first = runMigrations(nueva, { backupDir, preexisting: false });
  assert.equal(first.to, SCHEMA_VERSION, 'una base nueva queda en la versión actual');
  assert.equal(first.backup, null, 'una base sin datos previos no necesita copia pre-upgrade');
  assert.ok(nueva.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'app_meta'").get().n === 1);

  // Idempotente: correrla de nuevo no aplica nada.
  const again = runMigrations(nueva, { backupDir, preexisting: true });
  assert.deepEqual(again.applied, [], 'una base al día no vuelve a migrar');
  assert.equal(again.backup, null, 'sin migraciones pendientes no se saca copia');
  nueva.close();

  // ── Una base pre-versionado se adopta como baseline y migra con copia ─────
  const vieja = freshDb('vieja.db');
  vieja.exec('CREATE TABLE courses (id INTEGER PRIMARY KEY)');
  vieja.exec("INSERT INTO courses (id) VALUES (7)");
  assert.equal(Number(vieja.prepare('PRAGMA user_version').get().user_version), 0, 'nace sin versión');
  const migrated = runMigrations(vieja, { backupDir, preexisting: true });
  assert.equal(migrated.from, BASELINE_VERSION, 'una base con tablas y sin versión se adopta como baseline');
  assert.equal(migrated.to, SCHEMA_VERSION);
  assert.ok(migrated.backup && fs.existsSync(migrated.backup), 'una base con datos se respalda antes de migrar');
  const rescue = new DatabaseSync(migrated.backup, { readOnly: true });
  assert.equal(rescue.prepare('SELECT id FROM courses').get().id, 7, 'la copia pre-upgrade tiene los datos previos');
  rescue.close();
  assert.equal(minCompatibleVersion(vieja), 1, 'la migración declara hasta qué versión anterior sigue siendo legible');
  vieja.close();

  // ── Una migración que falla no deja cambios a medias ──────────────────────
  const rota = freshDb('rota.db');
  rota.exec('CREATE TABLE courses (id INTEGER PRIMARY KEY)');
  const failing = [
    ...MIGRATIONS,
    {
      version: SCHEMA_VERSION + 1,
      name: 'rompe-a-mitad',
      minCompatibleVersion: SCHEMA_VERSION,
      up(db) {
        db.exec('CREATE TABLE a_medias (id INTEGER PRIMARY KEY)');
        throw new Error('disco lleno');
      },
    },
  ];
  let error;
  try {
    runMigrations(rota, { backupDir, preexisting: true, migrations: failing });
  } catch (err) {
    error = err;
  }
  assert.ok(error instanceof MigrationFailedError, 'una migración rota levanta el error tipado');
  assert.match(error.message, /disco lleno/);
  assert.match(error.message, /restaurá/i, 'el error explica el camino de recuperación');
  assert.ok(error.backup && fs.existsSync(error.backup), 'el mensaje apunta a una copia que existe');
  assert.equal(
    rota.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'a_medias'").get().n,
    0,
    'la tabla creada por la migración fallida se revirtió'
  );
  assert.equal(
    Number(rota.prepare('PRAGMA user_version').get().user_version),
    SCHEMA_VERSION,
    'la versión se quedó en la última migración exitosa'
  );
  rota.close();

  // ── Una base más nueva: se acepta solo si declaró compatibilidad ──────────
  const futura = freshDb('futura.db');
  runMigrations(futura, { backupDir, preexisting: false });
  futura.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  futura
    .prepare('INSERT INTO schema_migrations (version, name, min_compatible_version) VALUES (?, ?, ?)')
    .run(SCHEMA_VERSION + 1, 'del-futuro-compatible', SCHEMA_VERSION);
  const downgraded = runMigrations(futura, { backupDir, preexisting: true });
  assert.equal(downgraded.downgraded, true, 'una versión anterior puede leer un esquema que la declaró compatible');

  futura
    .prepare('UPDATE schema_migrations SET min_compatible_version = ? WHERE version = ?')
    .run(SCHEMA_VERSION + 1, SCHEMA_VERSION + 1);
  assert.throws(() => runMigrations(futura, { backupDir, preexisting: true }), SchemaTooNewError, 'un esquema incompatible detiene el arranque');
  futura.close();
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ migraciones: versión de esquema, transaccionalidad, copia pre-upgrade y compatibilidad declarada');
