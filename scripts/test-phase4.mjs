// Contrato de las piezas que completan L4: prioridad FIFO persistida, respeto
// por el appointment y alerta independiente al operador. No abre Chromium ni
// toca el portal real.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-phase4-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_CRED_DB = path.join(dir, 'credentials.db');
process.env.MIKAMPUS_CRED_KEY = 'a'.repeat(64);
process.env.MIKAMPUS_SILENT = '1';
process.env.SYNC_TERM = '1930';

const { db } = await import('../src/db.js');
const { saveSection } = await import('../src/peoplesoft/catalog.js');
const { scrapedSectionSchema } = await import('../src/shared/schemas.ts');
const { storeCredential } = await import('../src/credentialVault.js');
const scheduler = await import('../src/scheduler.js');
const operator = await import('../src/operatorNotify.js');

const section = (status) =>
  scrapedSectionSchema.parse({
    courseCode: 'ICC-321', subject: 'ICC', catalogNbr: '321', title: 'ICC-321', career: 'GRDO', term: '1930',
    classNbr: '1000', section: '001', component: 'LEC', meetings: [], seats: { status, open: status === 'open' ? 1 : 0, capacity: 30, waitTotal: 0 },
  });

try {
  saveSection(section('closed'));
  for (const userId of [1, 2]) {
    db.prepare(`INSERT INTO cart_rows (user_id, idx, class_label, course_code, title, class_nbr, status)
                VALUES (?, 0, 'ICC-321', 'ICC-321', 'ICC-321', '1000', 'closed')`).run(userId);
    storeCredential(userId, { username: `u${userId}`, password: 'secret' }, {
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(), reason: 'test',
    });
  }
  const past = new Date(Date.now() - 60_000).toISOString();
  // Usuario 2 se activó primero: debe recibir el único intento aunque el rowid
  // y el orden de inserción favorezcan al usuario 1.
  db.prepare(`INSERT INTO watchers (user_id, interval_ms, auto_enroll, activation_order, appointment_at)
              VALUES (1, 45000, 1, 20, ?), (2, 45000, 1, 10, ?)`).run(past, past);

  const calls = [];
  const restoreRunner = scheduler.setWatcherEnrollmentRunner(async (userId) => {
    calls.push(userId);
    return { ok: true, results: [{ success: true, classLabel: 'ICC-321', message: 'Success' }] };
  });
  const restoreScanner = scheduler.setSharedWatcherScanner(async () => saveSection(section('open')));
  try {
    await scheduler.runSharedWatcherTick();
  } finally {
    restoreRunner();
    restoreScanner();
  }
  assert.deepEqual(calls, [2], 'un asiento se intenta una vez, para el primer watcher FIFO');
  assert.deepEqual(
    scheduler.getState(1).watcher.queue.map((item) => ({ ...item })),
    [{ courseCode: 'ICC-321', position: 2, total: 2 }],
    'la posición visible sale del orden persistido, no de memoria'
  );

  let alerts = 0;
  const restoreTransport = operator.setOperatorTransport(async () => {
    alerts++;
    return true;
  });
  try {
    await operator.reportOperatorFailure('watcher:ICC-321', 'timeout');
    await operator.reportOperatorFailure('watcher:ICC-321', 'timeout');
    await operator.reportOperatorFailure('watcher:ICC-321', 'timeout');
    assert.equal(alerts, 1, 'el operador recibe el tercer fallo consecutivo');
    operator.reportOperatorSuccess('watcher:ICC-321');
    await operator.reportOperatorFailure('watcher:ICC-321', 'timeout');
    assert.equal(alerts, 1, 'un éxito reinicia el contador de fallos');
  } finally {
    restoreTransport();
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ fase 4: watcher FIFO, cola persistida y fallback del operador');
