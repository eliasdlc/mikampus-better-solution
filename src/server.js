import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { withPage, shutdown } from './session.js';
import { readCart, syncCart } from './peoplesoft/cart.js';
import { getSearchFormOptions, searchClasses, addExactSectionToCart } from './peoplesoft/classSearch.js';
import { readCatalog } from './peoplesoft/catalog.js';
import { portalCatalogNbr } from './shared/courseCode.ts';
import { readSchedule, syncSchedule, latestScheduledTerm } from './peoplesoft/mySchedule.js';
import { fetchGrades, saveGrades, readGrades, termSummaries } from './peoplesoft/grades.js';
import { fetchAdvisement, savePensum, readPensum } from './peoplesoft/advisement.js';
import { fetchHolds, saveHolds, readHolds } from './peoplesoft/holds.js';
import { summarizeGrades } from './shared/gpa.ts';
import { db, lastSync } from './db.js';
import * as plans from './plans.js';
import * as scheduler from './scheduler.js';

// El término por defecto sale del .env, que es el que ya usa el resto de la app.
const DEFAULT_TERM = process.env.TARGET_TERM || null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '..', 'public', 'dist');
const app = express();
app.use(express.json());
app.use(express.static(DIST_DIR));

// Mismo trato que el horario y las notas: el GET sirve el cache de SQLite con
// su syncedAt (<10ms) y nunca dispara Playwright. Leer el carrito en vivo son
// ~10s y el Dashboard lo muestra en cada carga.
app.get('/api/cart', (req, res) => {
  res.json(readCart());
});

app.post('/api/cart/sync', async (req, res) => {
  try {
    await withPage((page) => syncCart(page));
    const cart = readCart();
    scheduler.emitEvent({ type: 'cart-status', rows: cart.rows, syncedAt: cart.syncedAt });
    res.json(cart);
  } catch (err) {
    scheduler.emitEvent({ type: 'log', message: `Error leyendo el carrito: ${err.message}` });
    res.status(500).json({ error: err.message });
  }
});

// Catálogo cacheado desde SQLite (<10ms). El ETag deriva de la última sync y
// del volumen de secciones: mientras no cambie, el browser recibe 304 y el
// índice MiniSearch no se reconstruye. El scraping en vivo va por otros
// endpoints; este solo sirve disco.
app.get('/api/catalog', (req, res) => {
  const term = req.query.term ? String(req.query.term) : null;
  const count = db.prepare('SELECT COUNT(*) AS n FROM sections' + (term ? ' WHERE term = ?' : '')).get(...(term ? [term] : [])).n;
  const etag = `"cat-${term ?? 'all'}-${count}-${lastSync('catalog', term) ?? '0'}"`;
  res.set('Cache-Control', 'no-cache');
  res.set('ETag', etag);
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.json(readCatalog(term));
});

// Términos que la DB local conoce (todo lo que tenga secciones), con sus
// fechas si Mi Horario las trajo: el planner las usa para elegir término al
// crear un plan y para acotar la recurrencia del export ICS.
app.get('/api/terms', (req, res) => {
  const terms = db
    .prepare(
      `SELECT s.term, MIN(e.start_date) AS start_date, MAX(e.end_date) AS end_date
       FROM sections s
       LEFT JOIN enrollments e ON e.term = s.term
       GROUP BY s.term
       ORDER BY s.term DESC`
    )
    .all()
    .map((r) => ({ term: r.term, startDate: r.start_date, endDate: r.end_date }));
  res.json({ terms });
});

// Mi Horario. Ojo con el nombre: /api/schedule (abajo) es el scheduler que
// dispara la inscripción a hora fija, otra cosa completamente. Esto es el
// horario inscrito, y por eso vive en /api/my-schedule.
//
// GET sirve siempre desde SQLite, aunque nunca se haya sincronizado: la UI
// muestra lo cacheado con su StalenessTag y decide si refrescar. Nunca dispara
// scraping solo por entrar a la pantalla.
// El término se resuelve solo: lo pedido explícitamente, si no lo del .env, y
// si no el último que se haya sincronizado. Sin nada de eso devuelve un horario
// vacío (no un error): la pantalla ofrece traerlo del portal, y el sync
// descubre el término activo sin que nadie lo configure.
app.get('/api/my-schedule', (req, res) => {
  const term = req.query.term ? String(req.query.term) : DEFAULT_TERM || latestScheduledTerm();
  res.json(readSchedule(term));
});

// El refresh en vivo es explícito. Tarda (es Playwright detrás), así que va
// emitiendo pasos por el SSE existente para que el LiveOpBanner los muestre.
app.post('/api/my-schedule/sync', async (req, res) => {
  try {
    const schedule = await withPage((page) =>
      syncSchedule(page, {
        onStep: (message) => scheduler.emitEvent({ type: 'log', message }),
      })
    );
    scheduler.emitEvent({
      type: 'log',
      message: `Horario actualizado: ${schedule.courses.length} materia(s) inscritas`,
    });
    res.json(readSchedule(schedule.term));
  } catch (err) {
    scheduler.emitEvent({ type: 'log', message: `Error leyendo el horario: ${err.message}` });
    res.status(500).json({ error: err.message });
  }
});

// ── Notas y avance (/academico) ─────────────────────────────────────────────
// Mismo trato que Mi Horario: el GET sirve lo cacheado con su StalenessTag y
// nunca dispara scraping por entrar a la pantalla. El índice se calcula acá
// (no se guarda) para que no exista una segunda verdad que pueda envejecer.
app.get('/api/grades', (req, res) => {
  const courses = readGrades();
  res.json({
    generatedAt: new Date().toISOString(),
    syncedAt: lastSync('grades'),
    terms: termSummaries(courses),
    summary: summarizeGrades(courses),
  });
});

app.post('/api/grades/sync', async (req, res) => {
  try {
    const { courses, mismatches } = await withPage((page) => fetchGrades(page));
    saveGrades(courses);
    // Si el índice calculado no cuadra con el que publica el portal, la
    // universidad cambió una regla: se avisa fuerte en vez de mostrar un
    // número plausible y falso (ver checkAgainstPortal).
    for (const m of mismatches) {
      scheduler.emitEvent({ type: 'log', message: `⚠ El índice no cuadra con el portal — ${m}` });
    }
    scheduler.emitEvent({ type: 'log', message: `Notas actualizadas: ${courses.length} materia(s)` });
    res.json({
      generatedAt: new Date().toISOString(),
      syncedAt: lastSync('grades'),
      terms: termSummaries(readGrades()),
      summary: summarizeGrades(readGrades()),
      mismatches,
    });
  } catch (err) {
    scheduler.emitEvent({ type: 'log', message: `Error leyendo las notas: ${err.message}` });
    res.status(500).json({ error: err.message });
  }
});

// El pénsum con su avance. `offered` marca las materias pendientes que este
// término tienen secciones en el catálogo local: NO es "cumplís el
// prerequisito" —el portal no publica prerequisitos en ningún lado (ver el
// recon de Fase 4)— es "te falta y se está ofertando". La UI no puede decir
// más que eso sin mentir.
app.get('/api/pensum', (req, res) => {
  const term = req.query.term ? String(req.query.term) : DEFAULT_TERM || latestScheduledTerm();
  const offered = new Set(
    term
      ? db
          .prepare(
            `SELECT DISTINCT c.code FROM sections s JOIN courses c ON c.id = s.course_id WHERE s.term = ?`
          )
          .all(term)
          .map((r) => r.code)
      : []
  );

  // El título es del catálogo (tabla courses), no del pénsum: el advisement no
  // lo trae y esta tabla no compite con el diccionario.
  const courses = db
    .prepare(
      `SELECT p.code, p.subject, p.catalog_nbr, p.units, p.status, p.taken_term, p.grade,
              c.id AS course_id, c.title
       FROM pensum p LEFT JOIN courses c ON c.code = p.code
       ORDER BY p.code`
    )
    .all()
    .map((r) => ({
      code: r.code,
      subject: r.subject,
      catalogNbr: r.catalog_nbr,
      units: r.units,
      status: r.status,
      takenTerm: r.taken_term,
      grade: r.grade,
      title: r.title ?? null,
      // Sin courseId no se puede agregar al plan: son las materias del pensum
      // que el catálogo local todavía no conoce.
      courseId: r.course_id ?? null,
      offered: r.status === 'pending' && offered.has(r.code),
    }));

  res.json({ term, generatedAt: new Date().toISOString(), syncedAt: lastSync('advisement'), courses });
});

app.post('/api/pensum/sync', async (req, res) => {
  try {
    scheduler.emitEvent({ type: 'log', message: 'Generando el informe de avance (tarda: lo arma el portal)…' });
    const { courses } = await withPage((page) => fetchAdvisement(page));
    const saved = savePensum(courses);
    scheduler.emitEvent({ type: 'log', message: `Pénsum actualizado: ${saved.length} materia(s)` });
    res.json({ ok: true, courses: saved.length });
  } catch (err) {
    scheduler.emitEvent({ type: 'log', message: `Error leyendo el pénsum: ${err.message}` });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/holds', (req, res) => {
  res.json({ generatedAt: new Date().toISOString(), syncedAt: lastSync('holds'), holds: readHolds() });
});

app.post('/api/holds/sync', async (req, res) => {
  try {
    const parsed = await withPage((page) => fetchHolds(page));
    saveHolds(parsed.holds);
    scheduler.emitEvent({
      type: 'log',
      message: parsed.holds.length ? `${parsed.holds.length} hold(s) activos` : 'Sin holds ni pendientes',
    });
    res.json({ generatedAt: new Date().toISOString(), syncedAt: lastSync('holds'), holds: readHolds(), todos: parsed.todos });
  } catch (err) {
    scheduler.emitEvent({ type: 'log', message: `Error leyendo los holds: ${err.message}` });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/enroll', async (req, res) => {
  try {
    const result = await scheduler.runEnrollNow('manual');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/search/options', async (req, res) => {
  try {
    const options = await withPage((page) => getSearchFormOptions(page));
    res.json(options);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/search', async (req, res) => {
  const { term, career, courseNumber } = req.body;
  if (!term || !career || !courseNumber) {
    return res.status(400).json({ error: 'Faltan term, career o courseNumber' });
  }
  try {
    const rows = await withPage((page) => searchClasses(page, { term, career, courseNumber }));
    res.json({ rows });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/search/add', async (req, res) => {
  const { term, career, courseNumber, classNbr, relatedClassNbr } = req.body;
  if (!term || !career || !courseNumber || !classNbr) {
    return res.status(400).json({ error: 'Faltan term, career, courseNumber o classNbr' });
  }
  try {
    const result = await withPage((page) =>
      addExactSectionToCart(page, { term, career, courseNumber, classNbr, relatedClassNbr })
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Planes ──────────────────────────────────────────────────────────────────
// CRUD puro sobre SQLite (<10ms): nada de esto toca el portal. La única
// operación viva de un plan es mandarlo al carrito (más abajo).
// Los errores de src/plans.js son de datos del usuario (plan inexistente,
// materia duplicada, sección de otro término) → 400 con el mensaje tal cual.

app.get('/api/plans', (req, res) => {
  res.json({ plans: plans.listPlans() });
});

app.post('/api/plans', (req, res) => {
  try {
    res.json(plans.createPlan(req.body ?? {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/plans/:id', (req, res) => {
  try {
    res.json(plans.readPlan(Number(req.params.id)));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.patch('/api/plans/:id', (req, res) => {
  try {
    res.json(plans.updatePlan(Number(req.params.id), req.body ?? {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/plans/:id', (req, res) => {
  try {
    plans.deletePlan(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/plans/:id/duplicate', (req, res) => {
  try {
    res.json(plans.duplicatePlan(Number(req.params.id)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/plans/:id/items', (req, res) => {
  try {
    res.json(plans.addPlanItem(Number(req.params.id), req.body ?? {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/plans/:id/items/:itemId', (req, res) => {
  try {
    res.json(plans.updatePlanItem(Number(req.params.id), Number(req.params.itemId), req.body ?? {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/plans/:id/items/:itemId', (req, res) => {
  try {
    res.json(plans.removePlanItem(Number(req.params.id), Number(req.params.itemId)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// La única operación viva de un plan: mandarlo al carrito real. Recorre los
// items con grupo elegido y agrega cada sección exacta en el portal, en la
// misma sesión Playwright (la fila de withPage garantiza que nada se cuele
// entremedio). El progreso sale por SSE para el LiveOpBanner; el resultado
// por materia (agregada ✓ / ya estaba / falló ✗ y por qué) va en la
// respuesta. Un fallo no corta el batch: las demás materias siguen.
app.post('/api/plans/:id/to-cart', async (req, res) => {
  let plan;
  try {
    plan = plans.readPlan(Number(req.params.id));
  } catch (err) {
    return res.status(404).json({ error: err.message });
  }
  const items = plan.items.filter((item) => item.section);
  if (items.length === 0) {
    return res.status(400).json({ error: 'El plan no tiene materias con grupo elegido' });
  }

  const results = await withPage(async (page) => {
    const out = [];
    for (const item of items) {
      scheduler.emitEvent({
        type: 'log',
        message: `Agregando ${item.title} (${item.code} · ${item.section.classNbr}) al carrito…`,
      });
      try {
        const r = await addExactSectionToCart(page, {
          term: plan.term,
          career: item.career ?? 'GRDO',
          courseNumber: portalCatalogNbr(item),
          classNbr: item.section.classNbr,
        });
        const alreadyInCart = !!r.alreadyInCart;
        out.push({ itemId: item.id, code: item.code, title: item.title, ok: true, alreadyInCart, error: null });
        scheduler.emitEvent({
          type: 'log',
          message: alreadyInCart ? `${item.title}: ya estaba en el carrito` : `${item.title}: agregada al carrito ✓`,
        });
      } catch (err) {
        out.push({ itemId: item.id, code: item.code, title: item.title, ok: false, alreadyInCart: false, error: err.message });
        scheduler.emitEvent({ type: 'log', message: `${item.title}: falló — ${err.message}` });
      }
    }
    return out;
  });

  scheduler.emitEvent({
    type: 'log',
    message: `Plan "${plan.name}" enviado: ${results.filter((r) => r.ok).length}/${results.length} materia(s) en el carrito`,
  });
  res.json({ results });
});

app.get('/api/state', (req, res) => {
  res.json(scheduler.getState());
});

app.post('/api/schedule', (req, res) => {
  try {
    scheduler.scheduleFixedTime(req.body.atISO);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/schedule', (req, res) => {
  scheduler.cancelSchedule();
  res.json({ ok: true });
});

app.post('/api/watch', (req, res) => {
  const { enabled, intervalMs } = req.body;
  if (enabled) {
    scheduler.startWatcher(intervalMs || 45000);
  } else {
    scheduler.stopWatcher();
  }
  res.json({ ok: true });
});

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('retry: 2000\n\n');

  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const unsubscribe = scheduler.onEvent(send);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

// Fallback de la SPA: cualquier ruta que no sea /api ni un archivo del build
// devuelve index.html para que React Router maneje el ruteo del lado del
// cliente (/buscar, /inscripcion, etc. al recargar).
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(DIST_DIR, 'index.html'));
});

const PORT = process.env.PORT || 4173;
const server = app.listen(PORT, () => {
  console.log(`pucmm-autoenroll backend en http://localhost:${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await shutdown();
    server.close(() => process.exit(0));
  });
}
