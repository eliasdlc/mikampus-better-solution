import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-backup-'));
process.env.MIKAMPUS_DB = path.join(dir, 'mikampus.db');
process.env.MIKAMPUS_BACKUP_DIR = path.join(dir, 'backups');
const { db } = await import('../src/db.js');
const { createBackup, nextBackupRun, rotateBackups } = await import('../src/backups.js');

db.exec("INSERT INTO subjects (code, description) VALUES ('ICC', 'Computación')");
for (let day = 1; day <= 8; day++) createBackup({ now: new Date(2026, 6, day, 12), keep: 7 });
const files = (await readdir(process.env.MIKAMPUS_BACKUP_DIR)).sort();
assert.equal(files.length, 7, 'rotación conserva siete copias diarias');
assert.equal(files[0], 'mikampus-2026-07-02.sqlite', 'la más vieja fue eliminada');
assert.equal(files.at(-1), 'mikampus-2026-07-08.sqlite');

const copy = new DatabaseSync(path.join(process.env.MIKAMPUS_BACKUP_DIR, files.at(-1)));
assert.equal(copy.prepare("SELECT description FROM subjects WHERE code = 'ICC'").get().description, 'Computación');
copy.close();
assert.equal(nextBackupRun(new Date(2026, 6, 18, 4), '03:30').getDate(), 19, 'si pasó la hora, corre mañana');

// La copia pre-upgrade es el camino de vuelta del ÚLTIMO cambio de esquema, así
// que la que nunca se puede borrar es la del número más alto. Ordenadas como
// texto, "v9" le gana a "v16" y la rotación se lleva justo esa.
for (const version of [7, 8, 9, 13, 15, 16]) {
  await writeFile(path.join(process.env.MIKAMPUS_BACKUP_DIR, `pre-upgrade-v${version}-2026-09-0${version % 9}.sqlite`), 'x');
}
rotateBackups(process.env.MIKAMPUS_BACKUP_DIR, 7);
const previas = (await readdir(process.env.MIKAMPUS_BACKUP_DIR))
  .filter((name) => name.startsWith('pre-upgrade-'))
  .map((name) => Number(name.match(/^pre-upgrade-v(\d+)-/)[1]))
  .sort((left, right) => left - right);
assert.deepEqual(previas, [13, 15, 16], 'sobreviven las tres más nuevas por número de esquema, no por orden alfabético');

await rm(dir, { recursive: true, force: true });
console.log('✓ backup SQLite consistente, rotación de siete días y la copia del último upgrade nunca se borra primero');
