// Ciclo de vida de las copias: última copia exitosa, catch-up tras un apagón,
// retención configurable, verificación real y exportación fuera de app-data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-backup-life-'));
process.env.MIKAMPUS_DATA_DIR = dir;
process.env.MIKAMPUS_DB = path.join(dir, 'mikampus.db');
process.env.MIKAMPUS_BACKUP_DIR = path.join(dir, 'backups');

const { db } = await import('../src/db.js');
const backups = await import('../src/backups.js');

try {
  db.exec("INSERT INTO subjects (code, description) VALUES ('ICC', 'Computación')");

  // Sin copias todavía: la primera siempre está vencida.
  assert.equal(backups.lastSuccessfulBackupAt(), null, 'una instalación nueva no tiene copia');
  assert.equal(backups.backupIsDue(new Date('2026-07-10T04:00:00Z')), true, 'sin copia previa, toca copiar');

  const created = backups.createBackup({ now: new Date('2026-07-10T04:00:00Z') });
  const verified = backups.verifyBackup(created);
  assert.ok(verified.tables > 0 && verified.bytes > 0, 'la copia se verifica al crearse');
  assert.equal(backups.lastSuccessfulBackupAt(), '2026-07-10T04:00:00.000Z', 'queda registrada como última copia exitosa');

  // El equipo estuvo apagado tres días: al volver, la copia está vencida y el
  // arranque la hace sin esperar a la hora programada.
  assert.equal(backups.backupIsDue(new Date('2026-07-10T20:00:00Z')), false, 'el mismo día no se repite');
  assert.equal(backups.backupIsDue(new Date('2026-07-13T09:00:00Z')), true, 'tras el apagón queda vencida');
  backups.startBackupCron({ now: new Date('2026-07-13T09:00:00Z') });
  assert.equal(
    backups.lastSuccessfulBackupAt(),
    '2026-07-13T09:00:00.000Z',
    'el catch-up del arranque hace la copia atrasada'
  );
  backups.stopBackupCron();

  // Retención configurable y persistida.
  backups.setRetention(2);
  assert.equal(backups.retention(), 2, 'la retención elegida sobrevive en la base');
  for (const day of [14, 15, 16, 17]) backups.createBackup({ now: new Date(`2026-07-${day}T04:00:00Z`) });
  const daily = backups.listBackups().filter((copy) => copy.kind === 'daily');
  assert.equal(daily.length, 2, 'la rotación respeta la retención configurada');

  // Una copia corrupta no pasa por buena: es la diferencia entre tener una
  // carpeta con archivos y tener un respaldo que restaura.
  const corrupta = path.join(dir, 'corrupta.sqlite');
  fs.writeFileSync(corrupta, 'esto no es una base sqlite');
  assert.throws(() => backups.verifyBackup(corrupta), /no/i, 'una copia ilegible se rechaza');

  // Exportar: destino elegido por el usuario, verificado al llegar.
  const destino = path.join(dir, 'usb');
  const exported = backups.exportBackup(destino, { now: new Date('2026-07-18T04:00:00Z') });
  assert.ok(fs.existsSync(exported.file), 'la exportación deja el archivo en la carpeta pedida');
  assert.equal(exported.sameDisk, true, 'informa cuando el destino comparte disco con los datos');
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ copias: última exitosa, catch-up tras apagón, retención, verificación y exportación');
