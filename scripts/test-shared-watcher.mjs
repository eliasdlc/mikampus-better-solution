// El watcher L4 contra SQLite desechable. No abre Chromium: se inyecta el
// scraper para comprobar la arquitectura que importa — una consulta por
// materia (no por usuario), snapshots, rotación por presupuesto y aviso de
// grupos nuevos.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-shared-watcher-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_CRED_DB = path.join(dir, 'credentials.db');
process.env.MIKAMPUS_CRED_KEY = crypto.randomBytes(32).toString('hex');
process.env.MIKAMPUS_SILENT = '1';
process.env.SYNC_TERM = '1930';

const { db } = await import('../src/db.js');
const { storeCredential } = await import('../src/credentialVault.js');
const { saveSection } = await import('../src/peoplesoft/catalog.js');
const { scrapedSectionSchema } = await import('../src/shared/schemas.ts');
const scheduler = await import('../src/scheduler.js');

const section = (courseCode, classNbr, status, over = {}) => {
  const [subject, catalogNbr] = courseCode.split('-', 2);
  return scrapedSectionSchema.parse({
    courseCode,
    subject,
    catalogNbr,
    title: courseCode,
    career: 'GRDO',
    term: '1930',
    classNbr,
    section: `0${classNbr}`,
    component: 'LEC',
    meetings: [],
    seats: { status, open: status === 'open' ? 1 : 0, capacity: 30, waitTotal: 0 },
    ...over,
  });
};

const addCart = (userId, index, courseCode, classNbr) => {
  db.prepare(
    `INSERT INTO cart_rows (user_id, idx, class_label, course_code, title, class_nbr, status)
     VALUES (?, ?, ?, ?, ?, ?, 'closed')`
  ).run(userId, index, `${courseCode} (${classNbr})`, courseCode, courseCode, classNbr);
};

const events = [];
const unsubscribe = scheduler.onEvent((event) => events.push(event));

try {
  // El baseline existe antes de activar el watcher: el siguiente NRC es de
  // verdad nuevo, no el primer catálogo que la máquina acaba de conocer.
  saveSection(section('ICC-321', '1000', 'closed'));
  saveSection(section('MAT-241', '2000', 'closed'));
  addCart(1, 0, 'ICC-321', '1000');
  addCart(2, 0, 'ICC-321', '1000');
  addCart(3, 0, 'MAT-241', '2000');
  db.exec(`
    INSERT INTO watchers (user_id, interval_ms) VALUES (1, 45000), (2, 45000), (3, 45000);
  `);
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  for (const userId of [1, 2, 3]) {
    storeCredential(userId, { username: `operator-${userId}`, password: 'test-only' }, { expiresAt, reason: 'watcher test' });
  }

  const scanned = [];
  const restoreScanner = scheduler.setSharedWatcherScanner(async (target) => {
    scanned.push(target.courseCode);
    if (target.courseCode === 'ICC-321') {
      // Cambia snapshots y agrega un grupo que no existía en la observación
      // anterior: exactamente los dos datos que el watcher debe publicar.
      saveSection(section('ICC-321', '1000', 'closed'));
      saveSection(section('ICC-321', '1001', 'open'));
    }
  });
  try {
    await scheduler.runSharedWatcherTick();
    await scheduler.runSharedWatcherTick();
  } finally {
    restoreScanner();
  }

  assert.deepEqual(scanned, ['ICC-321', 'MAT-241'], 'dos usuarios en ICC producen una sola consulta; el presupuesto rota a MAT');
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM seats_snapshot ss JOIN sections s ON s.id = ss.section_id WHERE s.class_nbr = '1001'`).get().n,
    1,
    'la consulta compartida escribe el snapshot del grupo recién abierto'
  );
  assert.ok(
    db.prepare('SELECT last_check_at FROM watchers WHERE user_id = 1').get().last_check_at,
    'quien vigila ICC registra cuándo se consultó su materia'
  );
  assert.ok(
    db.prepare('SELECT last_check_at FROM watchers WHERE user_id = 3').get().last_check_at,
    'la segunda vuelta alcanza la otra materia'
  );
  assert.equal(scheduler.getState(1).watcher.intervalMs, 90_000, 'dos materias / presupuesto uno = ciclo efectivo de 90s');

  const newGroupNotices = events.filter((event) => event.type === 'notice' && /grupo nuevo/.test(event.title));
  assert.deepEqual(
    newGroupNotices.map((event) => event.userId).sort(),
    [1, 2],
    'el grupo nuevo se informa a cada dueño del carrito que vigila la materia'
  );

  console.log('✓ watcher compartido: unión por materia, presupuesto rotativo, snapshots y diff de grupos nuevos');
} finally {
  unsubscribe();
  await rm(dir, { recursive: true, force: true });
}
