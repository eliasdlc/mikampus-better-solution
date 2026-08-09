// El orquestador de sincronización (P1) contra una DB desechable. Lo que se
// prueba es la política, no el scraping: orden por dependencias, colapso de
// pedidos simultáneos, relevancia por momento del ciclo, prioridad de una
// inscripción en curso y reanudación tras un hueco. Ningún test abre Chromium
// ni toca PUCMM — los runners van inyectados.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-sync-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_SILENT = '1';

const { db, logSync } = await import('../src/db.js');
const orchestrator = await import('../src/syncOrchestrator.js');

const USER = 1;
const restores = [];
const calls = [];

// Todas las fuentes quedan inyectadas: cuentan sus llamadas y registran su
// éxito en sync_log igual que lo haría el scraper real, que es de donde el
// orquestador deriva la frescura.
function stubAll({ failing = new Set() } = {}) {
  for (const source of orchestrator.SOURCES) {
    restores.push(
      orchestrator.setSourceRunner(source.key, async () => {
        calls.push(source.key);
        if (failing.has(source.key)) throw new Error(`falla simulada de ${source.key}`);
        logSync({ userId: USER, kind: source.key, status: 'ok' });
        return { detail: 'ok' };
      })
    );
  }
}

function statusOf(results, key) {
  return results.find((entry) => entry.key === key);
}

try {
  // ── Orden por dependencias ────────────────────────────────────────────────
  // No es el orden del array: sale del grafo. Ciclos antes que todo lo que se
  // cuelga de la identidad de ciclo; notas antes que avance.
  const order = orchestrator.orderedSources().map((source) => source.key);
  assert.ok(order.indexOf('terms') < order.indexOf('mySchedule'), 'ciclos van antes que horario');
  assert.ok(order.indexOf('terms') < order.indexOf('cart'), 'ciclos van antes que carrito');
  assert.ok(order.indexOf('terms') < order.indexOf('enrollmentWindows'), 'ciclos van antes que ventanas');
  assert.ok(order.indexOf('grades') < order.indexOf('advisement'), 'notas van antes que avance');

  // Pedir solo una fuente arrastra sus dependencias, no la corre suelta.
  const soloAvance = orchestrator.orderedSources(['advisement']).map((source) => source.key);
  assert.deepEqual(soloAvance, ['terms', 'grades', 'advisement'], 'pedir avance arrastra ciclos y notas');

  assert.throws(() => orchestrator.orderedSources(['inventada']), /desconocida/);

  // ── Sin sesión: pausa, no error, y el dato cacheado se conserva ───────────
  restores.push(orchestrator.setSessionProbe(() => false));
  stubAll();
  const sinSesion = await orchestrator.runSync(USER, { force: true, emit: () => {} });
  const horarioPausado = statusOf(sinSesion, 'mySchedule');
  assert.equal(horarioPausado.status, 'paused', 'sin sesión el horario queda pausado');
  assert.match(horarioPausado.reason, /iniciá sesión/i, 'la pausa explica qué falta');
  assert.equal(statusOf(sinSesion, 'terms').status, 'updated', 'lo que no necesita portal sigue corriendo');
  assert.equal(calls.filter((key) => key === 'mySchedule').length, 0, 'una pausa no ejecuta la operación');

  // Repetir no genera un loop de reintentos: mismo resultado, cero llamadas.
  const antes = calls.length;
  await orchestrator.runSync(USER, { force: true, emit: () => {} });
  assert.equal(
    calls.slice(antes).filter((key) => key !== 'terms').length,
    0,
    'sin sesión no se martilla el portal en cada pasada'
  );

  // ── Con sesión: se ejecuta y explica qué omitió y por qué ─────────────────
  restores.push(orchestrator.setSessionProbe(() => true));
  calls.length = 0;
  const conSesion = await orchestrator.runSync(USER, { force: true, emit: () => {} });

  // El carrito no aplica: no hay filas, ni ventana viva, ni watcher, ni disparo.
  const carrito = statusOf(conSesion, 'cart');
  assert.equal(carrito.status, 'skipped', 'fuera de inscripción el carrito no se consulta');
  assert.match(carrito.reason, /no aplica/i, 'omitir trae su razón');
  assert.ok(!calls.includes('cart'), 'una fuente irrelevante no toca el portal');

  assert.equal(statusOf(conSesion, 'mySchedule').status, 'updated');
  assert.equal(statusOf(conSesion, 'grades').status, 'updated');
  assert.equal(statusOf(conSesion, 'holds').status, 'updated');

  // ── Frescura: lo vigente no se vuelve a pedir; `force` sí lo fuerza ───────
  calls.length = 0;
  const sinForzar = await orchestrator.runSync(USER, { emit: () => {} });
  assert.equal(statusOf(sinForzar, 'mySchedule').status, 'fresh', 'dentro del TTL el horario está fresco');
  assert.ok(!calls.includes('mySchedule'), 'una fuente fresca no sale al portal');

  calls.length = 0;
  await orchestrator.runSync(USER, { force: true, emit: () => {} });
  assert.ok(calls.includes('mySchedule'), '"actualizar todo" sí fuerza lo vigente');

  // ── Diez pedidos simultáneos producen UNA operación por fuente ───────────
  calls.length = 0;
  const enParalelo = await Promise.all(
    Array.from({ length: 10 }, () => orchestrator.runSync(USER, { force: true, emit: () => {} }))
  );
  assert.equal(calls.filter((key) => key === 'grades').length, 1, 'diez componentes = una sola consulta de notas');
  assert.equal(calls.filter((key) => key === 'mySchedule').length, 1, 'diez componentes = una sola consulta de horario');
  for (const resultado of enParalelo) {
    assert.deepEqual(resultado, enParalelo[0], 'todos reciben el mismo resultado, no uno propio');
  }

  // ── Una dependencia caída no deja pasar a quien depende de ella ──────────
  while (restores.length) restores.pop()();
  calls.length = 0;
  restores.push(orchestrator.setSessionProbe(() => true));
  stubAll({ failing: new Set(['grades']) });
  const conFallo = await orchestrator.runSync(USER, { force: true, emit: () => {} });
  assert.equal(statusOf(conFallo, 'grades').status, 'error');
  const avance = statusOf(conFallo, 'advisement');
  assert.equal(avance.status, 'skipped', 'el avance no se recalcula contra notas que no se pudieron traer');
  assert.match(avance.reason, /Notas/, 'la omisión nombra la dependencia que falló');
  assert.ok(!calls.includes('advisement'), 'una dependencia rota no ejecuta al dependiente');

  // El error queda persistido por fuente, no solo en la respuesta HTTP.
  const estadoTrasFallo = orchestrator.syncState(USER);
  const filaNotas = estadoTrasFallo.sources.find((source) => source.key === 'grades');
  assert.equal(filaNotas.lastStatus, 'error');
  assert.match(filaNotas.error, /falla simulada/);

  // ── Una inscripción en curso manda sobre todo lo demás ───────────────────
  while (restores.length) restores.pop()();
  calls.length = 0;
  restores.push(orchestrator.setSessionProbe(() => true));
  stubAll();
  db.prepare("INSERT INTO schedules (user_id, at_iso, state) VALUES (?, ?, 'submitting')").run(
    USER,
    new Date(Date.now() + 3_600_000).toISOString()
  );

  const hold = orchestrator.portalHold(USER);
  assert.match(hold, /inscripción/i, 'un submit en curso bloquea el refresh');

  const durante = await orchestrator.runSync(USER, { force: true, emit: () => {} });
  assert.equal(statusOf(durante, 'cart').status, 'paused', 'el carrito no se refresca durante un submit');
  assert.ok(!calls.includes('cart'), 'ninguna acción mutante extra llega al portal durante la inscripción');
  assert.ok(!calls.includes('mySchedule'), 'ni siquiera una lectura se encola delante del submit');

  // Un disparo inminente (todavía pending) tiene la misma prioridad.
  db.prepare("UPDATE schedules SET state = 'pending', at_iso = ? WHERE user_id = ?").run(
    new Date(Date.now() + 5 * 60_000).toISOString(),
    USER
  );
  assert.match(orchestrator.portalHold(USER), /por dispararse/i, 'T-5min ya es zona de prioridad');

  // Un disparo lejano no bloquea nada.
  db.prepare('UPDATE schedules SET at_iso = ? WHERE user_id = ?').run(
    new Date(Date.now() + 6 * 3_600_000).toISOString(),
    USER
  );
  assert.equal(orchestrator.portalHold(USER), null, 'un disparo de dentro de seis horas no bloquea el refresh');

  // Con un disparo guardado, el carrito SÍ pasa a ser relevante.
  const conDisparo = orchestrator.syncState(USER).sources.find((source) => source.key === 'cart');
  assert.equal(conDisparo.relevant, true, 'con una inscripción en juego el carrito vuelve a importar');

  // ── Reanudar tras un hueco hace UNA pasada, no el replay de los ticks ────
  db.prepare('DELETE FROM schedules WHERE user_id = ?').run(USER);
  db.prepare('DELETE FROM sync_log').run();
  calls.length = 0;
  orchestrator.resetTickClock(Date.now() - 45 * 60_000);
  const mensajes = [];
  const tick = await orchestrator.syncTick(USER, { emit: (event) => mensajes.push(event) });
  assert.equal(tick.resumed, true, 'un hueco de 45 min se reconoce como reanudación');
  assert.equal(calls.filter((key) => key === 'grades').length, 1, 'reanudar consulta una vez, no una por tick perdido');
  assert.ok(
    mensajes.some((event) => /reanud/i.test(event.message ?? '')),
    'la reanudación se registra en el feed en vez de pasar callada'
  );

  // Un tick inmediatamente después no encuentra nada vencido.
  calls.length = 0;
  const seguido = await orchestrator.syncTick(USER, { emit: () => {} });
  assert.equal(seguido.ran, false, 'el tick liviano no sale al portal cuando no hay nada vencido');

  console.log(
    '✓ sync: orden por dependencias, una sola operación por fuente, relevancia por ciclo, prioridad de inscripción y reanudación sin replay'
  );
} finally {
  while (restores.length) restores.pop()();
  orchestrator.stopSyncLoop();
  await rm(dir, { recursive: true, force: true });
}
