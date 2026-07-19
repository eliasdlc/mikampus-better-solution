import 'dotenv/config';
import path from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { withPage, resetSession, shutdown } from './session.js';
import { getAccountInfo, setCredentials } from './credentials.js';
import { readCart, syncCart, validateCart } from './peoplesoft/cart.js';
import { getSearchFormOptions, searchClasses, addExactSectionToCart } from './peoplesoft/classSearch.js';
import { readCatalog } from './peoplesoft/catalog.js';
import { portalCatalogNbr } from './shared/courseCode.ts';
import { readSchedule, syncSchedule, latestScheduledTerm, removeEnrollmentCourse } from './peoplesoft/mySchedule.js';
import { readTerms, reconcileTerms, planningTerm } from './terms.js';
import { fetchGrades, saveGrades, readGrades, termSummaries, diffPublishedGrades } from './peoplesoft/grades.js';
import {
  fetchAdvisement,
  readPensum,
  saveRequirementTree,
  readRequirementTree,
  readProfile,
  earliestGradeTerm,
} from './peoplesoft/advisement.js';
import { fetchHolds, saveHolds, readHolds } from './peoplesoft/holds.js';
import { summarizeGrades, projectFinalGpa } from './shared/gpa.ts';
import { computeInsights } from './shared/insights.ts';
import { db, lastSync, clearPersonalData } from './db.js';
import * as plans from './plans.js';
import * as goals from './goals.js';
import * as scheduler from './scheduler.js';
import { startCatalogCron, stopCatalogCron } from './cron.js';
import { readEnrollmentWindows, syncEnrollmentWindows } from './peoplesoft/enrollmentWindows.js';
import { dropClass } from './peoplesoft/dropClass.js';
import { startBackupCron, stopBackupCron } from './backups.js';
import { recommendationForTerm, DEFAULT_MAX_CREDITS } from './recommendations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '..', 'public', 'dist');
const app = express();
app.use(express.json());
app.use(express.static(DIST_DIR));

// No toca PeopleSoft ni devuelve datos personales: permite que Docker detecte
// un proceso vivo antes de que Caddy le entregue tráfico.
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// ── Cuenta ───────────────────────────────────────────────────────────────────
// Devuelve el usuario vigente y de dónde sale (account.json o .env), nunca la
// contraseña. La pantalla de Ajustes lo usa para mostrar con qué cuenta estás.
app.get('/api/account', (req, res) => {
  res.json(getAccountInfo());
});

// Cambiar de cuenta desde la página. Hace las tres cosas que editar el .env a
// mano no hacía: persiste las credenciales, tira la sesión de Playwright (para
// que la próxima acción re-loguee con la cuenta nueva) y borra el cache
// personal en SQLite (si no, la página seguiría mostrando a la persona
// anterior, porque los GET sirven disco). Los datos se retraen con "sync".
app.post('/api/account', async (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Faltan usuario o contraseña' });
  }
  try {
    const account = setCredentials({ username, password });
    await resetSession();
    clearPersonalData();
    scheduler.emitEvent({
      type: 'log',
      message: `Cuenta cambiada a ${account.username}. Sincronizá cada pantalla para traer tus datos.`,
    });
    res.json({ ok: true, account });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.post('/api/cart/validate', async (req, res) => {
  try {
    scheduler.emitEvent({ type: 'log', message: 'Comprobando si PeopleSoft ofrece Validate…' });
    const result = await withPage((page) => validateCart(page));
    scheduler.emitEvent({ type: 'log', message: result.validate.supported ? 'Carrito validado' : result.validate.reason });
    res.json(result);
  } catch (err) {
    scheduler.emitEvent({ type: 'log', message: `No se pudo comprobar Validate: ${err.message}` });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/enrollment-windows', (req, res) => {
  const term = req.query.term ? String(req.query.term) : planningTerm(null, latestScheduledTerm());
  res.json(readEnrollmentWindows(term));
});

app.post('/api/enrollment-windows/sync', async (req, res) => {
  try {
    const windows = await withPage((page) =>
      syncEnrollmentWindows(page, {
        onStep: (message) => scheduler.emitEvent({ type: 'log', message }),
      })
    );
    scheduler.emitEvent({ type: 'log', message: `Ventana de inscripción actualizada: ${windows.length} sesión(es)` });
    res.json(readEnrollmentWindows(req.body?.term ? String(req.body.term) : null));
  } catch (err) {
    scheduler.emitEvent({ type: 'log', message: `Error leyendo Enrollment Dates: ${err.message}` });
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

// Términos que la DB local conoce, ya resueltos contra hoy: cuál ciclo corre
// (current), cuál sigue (next) y de cada uno su etiqueta, fechas y si tiene
// horario o secciones. El Dashboard y /horario leen current/next para no
// mezclar ciclos; el planner usa la lista (filtrando a plannable) para elegir
// término y acotar la recurrencia del ICS.
app.get('/api/terms', (req, res) => {
  res.json(readTerms());
});

// Mi Horario. Ojo con el nombre: /api/schedule (abajo) es el scheduler que
// dispara la inscripción a hora fija, otra cosa completamente. Esto es el
// horario inscrito, y por eso vive en /api/my-schedule.
//
// GET sirve siempre desde SQLite, aunque nunca se haya sincronizado: la UI
// muestra lo cacheado con su StalenessTag y decide si refrescar. Nunca dispara
// scraping solo por entrar a la pantalla.
// El término se resuelve solo: lo pedido explícitamente, si no el actual, y
// si no el último que se haya sincronizado. Sin nada de eso devuelve un horario
// vacío (no un error): la pantalla ofrece traerlo del portal, y el sync
// descubre el término activo sin que nadie lo configure.
app.get('/api/my-schedule', (req, res) => {
  // Sin término pedido, el default es el IDENTIFICADOR del ciclo actual (su STRM
  // si lo hay, si no su etiqueta) — nunca el último sincronizado, que era el bug:
  // 1930 (Septiembre) entraba como "actual" en julio. Ojo: cuando el ciclo actual
  // solo vive en grades (etiqueta sin STRM), readSchedule(etiqueta) no matchea
  // ningún enrollment y devuelve vacío. Eso es lo correcto: un horario vacío del
  // ciclo actual, no el de otro término disfrazado de actual. latestScheduledTerm
  // recién entra si hoy cae entre ciclos (no hay `current`).
  const current = readTerms().current;
  const term = req.query.term
    ? String(req.query.term)
    : current?.term ?? latestScheduledTerm();
  res.json(readSchedule(term));
});

// El refresh en vivo es explícito. Tarda (es Playwright detrás), así que va
// emitiendo pasos por el SSE existente para que el LiveOpBanner los muestre.
app.post('/api/my-schedule/sync', async (req, res) => {
  try {
    // El término lo elige el switcher de /horario (el STRM del ciclo activo).
    // Sin él, el sync toma el que el portal dé por defecto: es el arranque,
    // cuando todavía no se conoce el STRM del ciclo actual.
    const targetTerm = req.body?.term ? String(req.body.term) : null;
    const schedule = await withPage((page) =>
      syncSchedule(page, {
        targetTerm,
        onStep: (message) => scheduler.emitEvent({ type: 'log', message }),
      })
    );
    // El sync trajo el STRM del término y su etiqueta: reconciliar cruza ese
    // código con la etiqueta que grades ya usaba, así el modelo de tiempo sabe
    // a qué ciclo pertenece lo recién inscrito.
    reconcileTerms();
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

// Única acción destructiva de la app. El contrato exige escribir el código
// exacto; además corre sin retry automático para que un timeout posterior al
// submit no ejecute la baja dos veces.
app.post('/api/my-schedule/drop', async (req, res) => {
  const term = req.body?.term ? String(req.body.term) : null;
  const courseCode = req.body?.courseCode ? String(req.body.courseCode).trim().toUpperCase() : '';
  const classNbr = req.body?.classNbr ? String(req.body.classNbr) : null;
  const confirmCode = req.body?.confirmCode ? String(req.body.confirmCode).trim().toUpperCase() : '';
  if (!term || !courseCode || confirmCode !== courseCode) {
    return res.status(400).json({ error: 'Para dar de baja, escribí el código exacto de la materia' });
  }
  try {
    const result = await withPage(
      (page) =>
        dropClass(page, {
          term,
          courseCode,
          classNbr,
          onStep: (message) => scheduler.emitEvent({ type: 'log', message }),
        }),
      { retry: false }
    );
    if (!result.ok) return res.status(502).json(result);

    // El resultado del Paso 3 confirmó la baja. Se retira del cache local sin
    // depender de que Mi Horario siga ofreciendo ese ciclo inmediatamente.
    removeEnrollmentCourse(term, courseCode);
    scheduler.emitEvent({
      type: 'notice',
      title: `${courseCode} fue dada de baja`,
      body: result.message,
      key: `drop:${term}:${courseCode}`,
    });
    res.json({ ...result, schedule: readSchedule(term) });
  } catch (err) {
    scheduler.emitEvent({
      type: 'notice',
      level: 'error',
      title: `No se pudo dar de baja ${courseCode}`,
      body: err.message,
      key: `drop-error:${term}:${courseCode}`,
    });
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
    const previous = readGrades();
    const { courses, mismatches } = await withPage((page) => fetchGrades(page));
    const published = diffPublishedGrades(previous, courses);
    saveGrades(courses);
    // Las notas traen etiquetas de término que el modelo de tiempo no conocía.
    reconcileTerms();
    // Si el índice calculado no cuadra con el que publica el portal, la
    // universidad cambió una regla: se avisa fuerte en vez de mostrar un
    // número plausible y falso (ver checkAgainstPortal).
    for (const m of mismatches) {
      scheduler.emitEvent({ type: 'log', message: `⚠ El índice no cuadra con el portal — ${m}` });
    }
    for (const course of published) {
      scheduler.emitEvent({
        type: 'notice',
        title: `Se publicó tu nota de ${course.code}: ${course.grade}`,
        body: `${course.title ?? course.code} · ${course.term}`,
        key: `grade:${course.term}:${course.code}:${course.grade}`,
      });
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
  const term = planningTerm(req.query.term ? String(req.query.term) : null, latestScheduledTerm());
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
    const { profile, groups, courses } = await withPage((page) => fetchAdvisement(page));
    // La cohorte (primer término con notas) es de grades, no del informe.
    const saved = saveRequirementTree({ profile, groups, courses }, { cohortStartTerm: earliestGradeTerm() });
    scheduler.emitEvent({
      type: 'log',
      message: `Pénsum actualizado: ${saved.groups} grupos, ${saved.pensum} materia(s)`,
    });
    res.json({ ok: true, ...saved });
  } catch (err) {
    scheduler.emitEvent({ type: 'log', message: `Error leyendo el pénsum: ${err.message}` });
    res.status(500).json({ error: err.message });
  }
});

// El árbol de requisitos: período → obligatorios/electivas → cursos, tal cual el
// informe de avance. Cada curso se enriquece con el courseId del catálogo (para
// "agregar al plan") y si se oferta en el término pedido.
app.get('/api/requirements', (req, res) => {
  const term = planningTerm(req.query.term ? String(req.query.term) : null, latestScheduledTerm());
  const root = readRequirementTree();
  if (!root) {
    return res.json({ term, syncedAt: lastSync('advisement'), profile: readProfile(), tree: null });
  }

  const courseIdByCode = new Map(db.prepare('SELECT code, id FROM courses').all().map((r) => [r.code, r.id]));
  const offered = new Set(
    term
      ? db
          .prepare('SELECT DISTINCT c.code FROM sections s JOIN courses c ON c.id = s.course_id WHERE s.term = ?')
          .all(term)
          .map((r) => r.code)
      : []
  );

  const enrich = (node) => {
    for (const item of node.items) {
      item.courseId = courseIdByCode.get(item.code) ?? null;
      item.offered = item.status === 'pending' && offered.has(item.code);
    }
    node.children.forEach(enrich);
  };
  enrich(root);

  res.json({ term, syncedAt: lastSync('advisement'), profile: readProfile(), tree: root });
});

app.get('/api/profile', (req, res) => {
  res.json({ profile: readProfile(), syncedAt: lastSync('advisement') });
});

// ── Metas y señales (/academico, Fase 10 §12.7) ─────────────────────────────
// El contexto de las metas: los totales del índice (de las notas) y los créditos
// que faltan del pénsum (del árbol de requisitos). Una sola fuente para las
// proyecciones y para cada meta, así ambos miden lo mismo. Todo es cálculo local
// (<10ms), cero PeopleSoft: nunca dispara scraping por entrar a la pantalla.
function goalsContext() {
  const summary = summarizeGrades(readGrades());
  const remainingCredits = readRequirementTree()?.units?.needed ?? 0;
  return { summary, remainingCredits };
}

function goalsResponse() {
  const ctx = goalsContext();
  const hasBasis = ctx.summary.unitsTowardGpa > 0 || ctx.remainingCredits > 0;
  return {
    goals: goals.evaluateGoals(goals.listGoals(), ctx),
    projection: hasBasis ? projectFinalGpa(ctx.summary, ctx.remainingCredits) : null,
    basedOn: {
      gpa: ctx.summary.gpa,
      unitsTowardGpa: ctx.summary.unitsTowardGpa,
      remainingCredits: ctx.remainingCredits,
    },
    syncedAt: lastSync('grades'),
  };
}

app.get('/api/goals', (req, res) => res.json(goalsResponse()));

// Las mutaciones devuelven la respuesta entera (metas + proyección reevaluadas):
// la UI reemplaza el cache de un solo golpe, sin un segundo fetch.
app.post('/api/goals', (req, res) => {
  try {
    goals.createGoal({ kind: req.body?.kind ?? 'gpa', target: req.body?.target, deadlineTerm: req.body?.deadlineTerm });
    res.json(goalsResponse());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/goals/:id', (req, res) => {
  try {
    goals.updateGoal(Number(req.params.id), { target: req.body?.target, deadlineTerm: req.body?.deadlineTerm });
    res.json(goalsResponse());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/goals/:id', (req, res) => {
  try {
    goals.deleteGoal(Number(req.params.id));
    res.json(goalsResponse());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Señales descriptivas del histórico. Solo salen las que pasan su umbral de
// datos (shared/insights.ts); un arreglo vacío es "todavía no hay qué decir".
app.get('/api/insights', (req, res) => {
  const courses = readGrades();
  res.json({ insights: computeInsights(termSummaries(courses), courses), syncedAt: lastSync('grades') });
});

// Los códigos que le importan a TU carrera: todo lo del árbol de requisitos
// (obligatorias + candidatas de electiva) más lo que ya tenés inscrito. Es lo
// que acota la búsqueda carrera-first (§11): el índice arranca por acá y el chip
// "Todo el catálogo" abre el resto.
app.get('/api/pensum/codes', (req, res) => {
  const reqCodes = db.prepare('SELECT DISTINCT code FROM requirement_courses').all().map((r) => r.code);
  const enrolled = db
    .prepare(
      `SELECT DISTINCT c.code FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE e.status = 'enrolled'`
    )
    .all()
    .map((r) => r.code);
  res.json({ codes: [...new Set([...reqCodes, ...enrolled])] });
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

app.get('/api/recommendation', (req, res) => {
  try {
    const term = planningTerm(req.query.term ? String(req.query.term) : null, latestScheduledTerm());
    const maxCredits = req.query.maxCredits ?? DEFAULT_MAX_CREDITS;
    res.json(recommendationForTerm(term, maxCredits));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/recommendation/plan', (req, res) => {
  try {
    const term = planningTerm(req.body?.term ? String(req.body.term) : null, latestScheduledTerm());
    const proposal = recommendationForTerm(term, req.body?.maxCredits ?? DEFAULT_MAX_CREDITS);
    if (!proposal.schedule.valid || proposal.recommendations.length === 0) {
      throw new Error(proposal.caveats[0] ?? 'No hay una combinación recomendada para este ciclo');
    }
    const detail = plans.createPlanWithItems({
      term: proposal.term,
      name: req.body?.name?.trim() || 'Plan recomendado',
      items: proposal.recommendations.map((item) => ({
        courseId: item.courseId,
        sectionId: item.section.id,
        note: item.reason,
      })),
    });
    res.json(detail);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

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

// Por defecto SOLO localhost. app.listen(PORT) sin host escucha en todas las
// interfaces, así que hasta acá mikampus estaba abierto a la red entera sin que
// nadie lo hubiera pedido: cualquiera en el mismo WiFi podía abrirlo y usar tu
// sesión de PeopleSoft — inscribir, dar de baja, leer tus notas. No hay login:
// la app asume que quien la abre sos vos.
//
// HOST=0.0.0.0 lo expone a propósito para abrirlo desde el teléfono (plan §6).
// Las credenciales siguen sin salir de tu máquina — el .env y la sesión de
// Playwright viven acá— pero la app queda al alcance de tu red. En el WiFi de
// tu casa es razonable; en el de la universidad, durante la inscripción, no.
const HOST = process.env.HOST || '127.0.0.1';

// Las IPs por las que el teléfono puede llegar. Se imprimen porque el usuario
// las necesita para tipearlas y "averiguá tu IP" no es una instrucción.
function lanUrls() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${PORT}`);
}

// Cruza los términos que ya están en disco (STRM inscritos + etiquetas de
// grades) al arrancar, para que el modelo de tiempo esté al día sin esperar a
// una sync. Es barato: son pocas filas y upserts idempotentes.
reconcileTerms();

const server = app.listen(PORT, HOST, () => {
  console.log(`mikampus en http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    for (const url of lanUrls()) console.log(`  · en tu red: ${url}`);
    console.log('  ⚠ abierto a tu red local: cualquiera en este WiFi puede usar tu sesión del portal.');
  }
  // Apagado salvo que CATALOG_CRON_AT diga a qué hora (ver src/cron.js).
  startCatalogCron();
  startBackupCron();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    stopCatalogCron();
    stopBackupCron();
    await shutdown();
    server.close(() => process.exit(0));
  });
}
