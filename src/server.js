import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import { persistRamCredential, withPage, resetSession, shutdown } from './session.js';
import { readCart, removeFromCart, saveCart, syncCart, validateCart } from './peoplesoft/cart.js';
import { getSearchFormOptions, searchClasses, addExactSectionToCart } from './peoplesoft/classSearch.js';
import { readClassDropDeadlines, syncEnrollmentDeadlines } from './peoplesoft/enrollmentDeadlines.js';
import { lectureSections } from './shared/sections.ts';
import { readCatalog, seatHistory, syncCatalogCourse, applyPlanFacts, readHomeCampus, setHomeCampus } from './peoplesoft/catalog.js';
import { readTermEvents, saveTermEvents, termPhase } from './termEvents.js';
import { readMesa, mesaPlan } from './mesa.js';
import { solveCombinations, NO_CONSTRAINTS } from './shared/solver.ts';
import { portalCatalogNbr } from './shared/courseCode.ts';
import { readSchedule, syncSchedule, latestScheduledTerm, removeEnrollmentCourse } from './peoplesoft/mySchedule.js';
import { readTerms, reconcileTerms, planningTerm, currentTermCode } from './terms.js';
import { fetchGrades, saveGrades, readGrades, termSummaries, diffPublishedGrades, readOfficialTotals } from './peoplesoft/grades.js';
import {
  fetchAdvisement,
  readPensum,
  saveRequirementTree,
  readRequirementTree,
  requirementCodes,
  readProfile,
  earliestGradeTerm,
} from './peoplesoft/advisement.js';
import { fetchHolds, saveHolds, readHolds } from './peoplesoft/holds.js';
import { summarizeGrades, projectFinalGpa } from './shared/gpa.ts';
import { computeInsights } from './shared/insights.ts';
import { buildProjection, creditsInProgressFor } from './shared/projection.ts';
import { db, lastSync, deleteAllUserData, logAction, readActions } from './db.js';
import { getUser, LOCAL_USER_ID } from './users.js';
import * as auth from './auth.js';
import { credentialInfo, deleteCredential, purgeExpiredCredentials } from './credentialVault.js';
import * as plans from './plans.js';
import * as goals from './goals.js';
import * as scheduler from './scheduler.js';
import { startCatalogCron, stopCatalogCron } from './cron.js';
import { readEnrollmentWindows, syncEnrollmentWindows } from './peoplesoft/enrollmentWindows.js';
import { dropClass } from './peoplesoft/dropClass.js';
import { startBackupCron, stopBackupCron } from './backups.js';
import { recommendationForTerm, recommendationOptions, degreePathFor, planForUser, STRATEGIES, DEFAULT_MAX_CREDITS } from './recommendations.js';
import { vapidPublicKey, saveSubscription, removeSubscription } from './webpush.js';
import { acquireAgentLock, agentHealthAuthorized, recordRuntimeStart, recordRuntimeStop, releaseAgentLock } from './runtime.js';
import { resourcePath } from './paths.js';
import { chooseMode, markOnboardingComplete, onboardingState, publishRuntimeMode, startBrowserInstall } from './onboarding.js';
import { fullStatus } from './status.js';
import { clearNotifications, markFeedRead, readFeed, unreadCount } from './notifications.js';
import { availableAdapters, deleteChannel, listChannels, saveChannel, setChannelEnabled, testChannel } from './channels.js';
import { backupState, createBackup, exportBackup, setRetention } from './backups.js';
import { erasePreview, eraseLocalArtifacts } from './erase.js';
import { exportDiagnostics, listDiagnostics } from './diagnostics.js';
import { checkForUpdate, setUpdatePolicy } from './updates.js';
import { requireScraperMutationSupport } from './scraperSupport.js';
import { markSourceSynced, pendingSync, runSync, setSyncIntervalMs, startSyncLoop, stopSyncLoop, syncState } from './syncOrchestrator.js';
import { readCalendar } from './academicCalendar.js';
import { seatTrend, describeTrend } from './shared/seatTrend.ts';
import { setReminderSettings, reminderStatus, startClassReminders, stopClassReminders } from './classReminders.js';

const DIST_DIR = resourcePath('public', 'dist');
const app = express();
app.use(express.json());
app.use(express.static(DIST_DIR));

// No toca PeopleSoft ni devuelve datos personales: health local del agente.
app.get('/api/health', (req, res) => {
  if (!agentHealthAuthorized(req)) return res.status(401).json({ error: 'healthcheck del agente no autorizado' });
  res.json({ ok: true, pid: process.pid, url: `http://127.0.0.1:${PORT}` });
});

// Se decide por request y no por build. En loopback la UI viaja por http y
// marcar Secure dejaría la cookie inservible; detrás de un proxy que termina
// TLS, no marcarla la dejaría viajar en claro el día que ese proxy se caiga a
// http. El único que puede mentir en esta cabecera es algo que ya está en
// loopback, y lo peor que consigue es que la cookie no se envíe: molesta, no
// escala privilegios.
function secureCookies(req) {
  return String(req.headers['x-forwarded-proto'] ?? '').toLowerCase() === 'https';
}

// El portal solo publicó fechas en el recon actual. Para que la credencial no
// sobreviva al período de inscripción, convertimos el cierre publicado en el
// último instante de ese día Santo Domingo; nunca aceptamos una fecha elegida
// libremente por el cliente.
function unattendedExpiry(userId, term) {
  if (!term) throw new Error('Elegí el ciclo de inscripción antes de activar una función desatendida');
  const window = db
    .prepare('SELECT ends_at FROM enrollment_windows WHERE user_id = ? AND term_code = ? ORDER BY ends_at DESC LIMIT 1')
    .get(userId, String(term));
  if (!window?.ends_at) throw new Error('Actualizá tu ventana de inscripción antes de activar esta función');
  const expiresAt = new Date(`${window.ends_at}T23:59:59.999-04:00`).toISOString();
  if (new Date(expiresAt).getTime() <= Date.now()) throw new Error('La ventana de inscripción de ese ciclo ya cerró');
  return expiresAt;
}

function authorizeUnattendedCredential(userId, { consent, term, reason }) {
  if (consent !== true) throw new Error('Confirmá el consentimiento para guardar la credencial cifrada hasta el cierre de inscripción');
  persistRamCredential(userId, { expiresAt: unattendedExpiry(userId, term), reason });
}

function revokeUnattendedCredentialIfUnused(userId) {
  const scheduled = db.prepare('SELECT 1 FROM schedules WHERE user_id = ?').get(userId);
  const watching = db.prepare('SELECT 1 FROM watchers WHERE user_id = ?').get(userId);
  if (!scheduled && !watching) deleteCredential(userId);
}

// La política de refresco ya no vive acá: es el registro de fuentes de
// src/syncOrchestrator.js, con dependencias, relevancia y prioridad. Este
// archivo solo expone la puerta HTTP.

app.use('/api', auth.localRequestGuard, auth.authMiddleware);

// ── Onboarding (Fase 4 §1 y §2): primer uso sin terminal ────────────────────
// Público: corre antes de que exista una cuenta. No expone datos personales, y
// el guard local ya exigió loopback y Origin propio.
app.get('/api/onboarding', async (req, res) => {
  try {
    res.json(await onboardingState());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/onboarding/mode', (req, res) => {
  try {
    res.json({ mode: chooseMode(req.body?.mode) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// El browser se instala desde la UI, con progreso y sin pedir la contraseña
// primero: hasta que Chromium no esté, mikampus no puede verificar nada contra
// PUCMM y no tiene sentido recibir una credencial que no puede usar.
app.post('/api/onboarding/browser', async (req, res) => {
  try {
    res.json(await startBrowserInstall());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/onboarding/complete', (req, res) => {
  res.json({ completedAt: markOnboardingComplete() });
});

// ── Auth (§5): el login de mikampus ES el login del portal ──────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { user, token, csrfToken, expiresAt } = await auth.loginWithPortal(req.body ?? {});
    scheduler.emitEvent({ type: 'log', message: `Sesión iniciada: ${user.portalUsername}` });
    res.set('Set-Cookie', auth.sessionCookieHeader(token, { secure: secureCookies(req) }));
    res.json({ ok: true, user: { id: user.id, username: user.portalUsername }, csrfToken, expiresAt });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    await auth.logout(auth.cookieValue(req.headers.cookie, auth.SESSION_COOKIE));
    res.set('Set-Cookie', auth.clearedSessionCookieHeader({ secure: secureCookies(req) }));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Quién soy + el CSRF token de mi sesión: lo primero que pide la SPA al abrir.
app.get('/api/auth/me', (req, res) => {
  const user = getUser(req.userId);
  const session = req.sessionToken ? auth.sessionFor(req.sessionToken) : null;
  res.json({
    mode: 'local',
    user: user ? { id: user.id, username: user.portalUsername } : null,
    csrfToken: session?.csrfToken ?? null,
  });
});

// La información de confianza que Ajustes muestra siempre: el estado de la
// excepción de credencial persistida, las últimas syncs y el audit log viven
// detrás de la misma sesión del usuario; ninguno filtra datos entre cuentas.
app.get('/api/account/overview', (req, res) => {
  const syncKinds = [
    ['mySchedule', 'Horario'],
    ['cart', 'Carrito'],
    ['grades', 'Notas'],
    ['advisement', 'Avance'],
    ['holds', 'Holds'],
  ];
  res.json({
    user: getUser(req.userId),
    credential: credentialInfo(req.userId),
    syncs: syncKinds.map(([kind, label]) => ({ kind, label, syncedAt: lastSync(kind, { userId: req.userId }) })),
  });
});

// ── Web Push (§5.5): la mitad accionable del watcher ────────────────────────
// La llave pública es lo único que el navegador necesita para suscribirse; es
// pública por diseño (la privada nunca sale del server). null = canal apagado,
// y la UI lo trata como "push no disponible" en vez de romper.
app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: vapidPublicKey() });
});

// El navegador manda su suscripción (endpoint + claves del dispositivo); se
// guarda atada a este usuario. Un re-subscribe del mismo teléfono actualiza.
app.post('/api/push/subscribe', (req, res) => {
  try {
    saveSubscription(req.userId, req.body?.subscription, req.headers['user-agent'] ?? null);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Al revocar permiso o cerrar sesión en un dispositivo, se borra SOLO ese
// endpoint: los otros teléfonos del usuario siguen recibiendo.
app.post('/api/push/unsubscribe', (req, res) => {
  const endpoint = req.body?.endpoint;
  if (endpoint) removeSubscription(req.userId, endpoint);
  res.json({ ok: true });
});

// ── Estado permanente (Fase 4 §3) ───────────────────────────────────────────
// Una sola lectura barata: agente, watcher, gap, backoff, próxima acción,
// vencimiento de credencial, copias y si el equipo tiene que seguir despierto.
app.get('/api/status', (req, res) => {
  try {
    res.json(fullStatus(req.userId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Notificaciones: feed durable + adaptadores opcionales (§4 y §5) ─────────
app.get('/api/notifications', (req, res) => {
  res.json({ items: readFeed(req.userId), unread: unreadCount(req.userId) });
});

app.post('/api/notifications/read', (req, res) => {
  res.json({ marked: markFeedRead(req.userId) });
});

app.get('/api/notifications/channels', (req, res) => {
  res.json({ channels: listChannels(), adapters: availableAdapters() });
});

app.post('/api/notifications/channels', (req, res) => {
  try {
    const id = saveChannel({ kind: req.body?.kind, label: req.body?.label, destination: req.body?.destination });
    res.json({ id, channels: listChannels() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/notifications/channels/:id', (req, res) => {
  try {
    setChannelEnabled(Number(req.params.id), Boolean(req.body?.enabled));
    res.json({ channels: listChannels() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/notifications/channels/:id', (req, res) => {
  deleteChannel(Number(req.params.id));
  res.json({ channels: listChannels() });
});

app.post('/api/notifications/channels/:id/test', async (req, res) => {
  try {
    const result = await testChannel(Number(req.params.id));
    res.json({ ...result, channels: listChannels() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Copias de seguridad (§7 y §8) ───────────────────────────────────────────
app.get('/api/backups', (req, res) => {
  res.json(backupState());
});

app.post('/api/backups', (req, res) => {
  try {
    res.json({ file: createBackup(), state: backupState() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/backups', (req, res) => {
  try {
    setRetention(req.body?.keep);
    res.json(backupState());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Exportar es explícito y a una carpeta que elige el usuario. No hay backup a
// una nube, ni silencioso ni opcional.
app.post('/api/backups/export', (req, res) => {
  try {
    res.json(exportBackup(req.body?.directory));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Diagnósticos (§10) ──────────────────────────────────────────────────────
app.get('/api/diagnostics', (req, res) => {
  res.json({
    files: listDiagnostics(),
    note: 'Los diagnósticos viven en la carpeta de datos de la app. Las capturas pueden mostrar información del portal: revisalas antes de compartirlas.',
  });
});

app.post('/api/diagnostics/export', (req, res) => {
  try {
    res.json(exportDiagnostics(req.body?.directory));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Updates (§11): manuales o apagados, nunca automáticos ───────────────────
app.post('/api/updates/check', async (req, res) => {
  res.json(await checkForUpdate());
});

app.patch('/api/updates', (req, res) => {
  try {
    res.json({ policy: setUpdatePolicy(req.body?.policy) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Qué se borraría, antes de borrarlo. Un "borrar todo" sin preview es una
// promesa que el usuario no puede verificar.
app.get('/api/account/erase-preview', (req, res) => {
  res.json(erasePreview());
});

app.delete('/api/account/data', async (req, res) => {
  try {
    // Primero se corta todo lo que pueda tocar el portal; después se borra la
    // identidad local. Así una carrera con un timer restaurado no puede revivir
    // una cuenta que ya pidió desaparecer.
    // Una actualización silenciosa que arrancó al entrar puede seguir en la
    // cola de Playwright. Esperarla evita que escriba filas nuevas después del
    // borrado solicitado.
    await pendingSync(req.userId);
    scheduler.cancelSchedule(req.userId);
    scheduler.stopWatcher(req.userId);
    await resetSession(req.userId);
    deleteCredential(req.userId);
    auth.revokeAllSessions(req.userId);
    deleteAllUserData(req.userId);
    clearNotifications();
    // Con el agente vivo la base y su runtime están abiertos: sus filas ya se
    // borraron arriba. Lo que sí se puede quitar del disco ahora son las copias
    // y los diagnósticos, que son justamente donde quedaría una captura del
    // portal después de un "borrar todo". Los archivos restantes los elimina
    // `mikampus erase-data`, que detiene el agente primero.
    const removed = req.body?.keepBackups
      ? eraseLocalArtifacts({ onlyRuntimeSafe: true, keep: ['backups'] })
      : eraseLocalArtifacts({ onlyRuntimeSafe: true });
    res.set('Set-Cookie', auth.clearedSessionCookieHeader({ secure: secureCookies(req) }));
    res.json({ ok: true, removed, note: 'Para borrar también la base, el vault y el browser descargado, ejecutá `mikampus erase-data --yes`.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sincronización universal (P1) ───────────────────────────────────────────
// Una sola definición de frescura para toda la app. El GET es barato (SQLite) y
// responde "qué está viejo y por qué"; el POST es el único camino al portal.
app.get('/api/sync', (req, res) => {
  res.json(syncState(req.userId));
});

// Cada cuánto se considera vieja la información scrapeada. Es un techo sobre la
// frescura declarada por cada fuente, no un disparo: cambiarlo no sale al
// portal, solo mueve la línea a partir de la cual el próximo tick lo hará.
app.patch('/api/sync', (req, res) => {
  try {
    setSyncIntervalMs(req.body?.intervalMs);
    res.json({ state: syncState(req.userId) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// `force` incluye las fuentes vigentes; no evade consentimiento ni prioridad.
// `keys` acota a un subconjunto y arrastra sus dependencias.
app.post('/api/sync', async (req, res) => {
  try {
    const keys = Array.isArray(req.body?.keys) && req.body.keys.length ? req.body.keys.map(String) : undefined;
    const results = await runSync(req.userId, { force: Boolean(req.body?.force), keys });
    res.json({ results, state: syncState(req.userId) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Mismo trato que el horario y las notas: el GET sirve el cache de SQLite con
// su syncedAt (<10ms) y nunca dispara Playwright. Leer el carrito en vivo son
// ~10s y el Dashboard lo muestra en cada carga.
app.get('/api/cart', (req, res) => {
  res.json(readCart(req.userId));
});

app.post('/api/cart/sync', async (req, res) => {
  try {
    await withPage(req.userId, (page) => syncCart(page, { userId: req.userId }));
    const cart = readCart(req.userId);
    scheduler.emitEvent({ type: 'cart-status', rows: cart.rows, syncedAt: cart.syncedAt });
    markSourceSynced(req.userId, 'cart');
    res.json(cart);
  } catch (err) {
    scheduler.emitEvent({ type: 'log', message: `Error leyendo el carrito: ${err.message}` });
    res.status(500).json({ error: err.message });
  }
});

// Quitar una materia del carrito. Escribe en el portal, así que pasa por el
// mismo gate que agregar e inscribir, y queda en el historial de acciones: todo
// lo que mikampus cambia de tu lado allá afuera se puede auditar después.
app.post('/api/cart/remove', async (req, res) => {
  const { classNbr = null, courseCode = null } = req.body ?? {};
  if (!classNbr && !courseCode) {
    return res.status(400).json({ error: 'Faltan classNbr o courseCode' });
  }
  try {
    requireScraperMutationSupport();
    const { removed, rows } = await withPage(req.userId, (page) =>
      removeFromCart(page, {
        classNbr,
        courseCode,
        onStep: (message) => scheduler.emitEvent({ type: 'log', message }),
      })
    );
    saveCart(req.userId, rows);
    logAction({
      userId: req.userId,
      action: 'remove-from-cart',
      detail: `${removed.courseCode ?? removed.classLabel}${removed.classNbr ? ` · NRC ${removed.classNbr}` : ''}`,
      response: 'quitada del carrito',
      ok: true,
    });
    const cart = readCart(req.userId);
    scheduler.emitEvent({ type: 'cart-status', rows: cart.rows, syncedAt: cart.syncedAt });
    scheduler.emitEvent({
      type: 'log',
      message: `${removed.courseCode ?? removed.classLabel} quitada del carrito`,
    });
    res.json(cart);
  } catch (err) {
    logAction({
      userId: req.userId,
      action: 'remove-from-cart',
      detail: courseCode ?? `NRC ${classNbr}`,
      response: err.message,
      ok: false,
    });
    scheduler.emitEvent({ type: 'log', message: `No se pudo quitar del carrito: ${err.message}` });
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/cart/validate', async (req, res) => {
  try {
    scheduler.emitEvent({ type: 'log', message: 'Comprobando si PeopleSoft ofrece Validate…' });
    const result = await withPage(req.userId, (page) => validateCart(page));
    scheduler.emitEvent({ type: 'log', message: result.validate.supported ? 'Carrito validado' : result.validate.reason });
    res.json(result);
  } catch (err) {
    scheduler.emitEvent({ type: 'log', message: `No se pudo comprobar Validate: ${err.message}` });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/enrollment-windows', (req, res) => {
  const term = req.query.term ? String(req.query.term) : planningTerm(null, latestScheduledTerm(req.userId));
  res.json(readEnrollmentWindows(req.userId, term));
});

app.post('/api/enrollment-windows/sync', async (req, res) => {
  try {
    const windows = await withPage(req.userId, (page) =>
      syncEnrollmentWindows(page, {
        userId: req.userId,
        onStep: (message) => scheduler.emitEvent({ type: 'log', message }),
      })
    );
    scheduler.emitEvent({ type: 'log', message: `Ventana de inscripción actualizada: ${windows.length} sesión(es)` });
    markSourceSynced(req.userId, 'enrollmentWindows');
    res.json(readEnrollmentWindows(req.userId, req.body?.term ? String(req.body.term) : null));
  } catch (err) {
    scheduler.emitEvent({ type: 'log', message: `Error leyendo Enrollment Dates: ${err.message}` });
    res.status(500).json({ error: err.message });
  }
});

// ── Calendario del ciclo y fases ────────────────────────────────────────────
// El portal publica UNA ventana por ciclo (Enrollment Dates) y nada más: las
// fechas de modificación, retiro y notas viven en el calendario académico que
// PUCMM publica fuera del portal. Por eso el estudiante puede cargarlas, y por
// eso lo que no cargó queda explícitamente ausente en vez de aparecer inventado.

// Un ZodError trae el detalle en `issues`; su `message` es un JSON que nadie
// puede leer en un aviso de pantalla.
function readableError(err) {
  const issues = err?.issues;
  if (!Array.isArray(issues)) return err.message;
  return issues.map((issue) => (issue.path?.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message)).join('; ');
}

app.get('/api/term-events', (req, res) => {
  const { term, termLabel } = termPhase(req.userId, { term: req.query.term ? String(req.query.term) : null });
  res.json({ term, termLabel, events: term ? readTermEvents(req.userId, term) : [] });
});

// Reemplaza el calendario cargado a mano de un ciclo por la lista que llega:
// borrar una fecha es no mandarla. Nunca toca lo que dijo el portal, y responde
// con el estado de fase recalculado para que la UI no tenga que pedirlo aparte.
app.put('/api/term-events', (req, res) => {
  try {
    const term = req.body?.term ? String(req.body.term) : null;
    if (!term) throw new Error('Elegí el ciclo al que pertenece el calendario');
    if (!Array.isArray(req.body?.events)) throw new Error('El calendario viaja como una lista de eventos');
    saveTermEvents(req.userId, term, req.body.events);
    res.json(termPhase(req.userId, { term }));
  } catch (err) {
    res.status(400).json({ error: readableError(err) });
  }
});

// La lectura única desde la que el frontend gatea toda la app: etapa del ciclo,
// cuánto falta, qué fechas faltan por cargar y el estado de cada capacidad con
// su motivo legible. Que venga todo junto es el punto: si cada pantalla
// comparara fechas por su cuenta, en dos semanas habría tres reglas distintas.
//
// El servidor NO bloquea por fase. Una segunda capa de reglamento construida
// sobre fechas tipeadas a mano solo puede producir falsos negativos: PeopleSoft
// ya rechaza lo que hay que rechazar y action_log guarda su respuesta literal.
// La única excepción sigue siendo POST /api/schedule, que no decide si una
// acción es legal sino cuánto tiempo vive una credencial cifrada en disco.
app.get('/api/term-phase', (req, res) => {
  res.json(termPhase(req.userId, { term: req.query.term ? String(req.query.term) : null }));
});

// Catálogo cacheado desde SQLite (<10ms). El ETag deriva de la última sync y
// del volumen de secciones: mientras no cambie, el browser recibe 304 y el
// índice MiniSearch no se reconstruye. El scraping en vivo va por otros
// endpoints; este solo sirve disco.
app.get('/api/catalog', (req, res) => {
  const term = req.query.term ? String(req.query.term) : null;
  const count = db.prepare('SELECT COUNT(*) AS n FROM sections' + (term ? ' WHERE term = ?' : '')).get(...(term ? [term] : [])).n;
  // El campus del perfil entra en el ETag porque decide el ORDEN de la
  // respuesta: sin él, cambiar de campus en Ajustes devolvería 304 y el browser
  // seguiría mostrando el orden viejo hasta que cambiara el conteo de secciones.
  const homeCampus = readHomeCampus(req.userId);
  const etag = `"cat-${term ?? 'all'}-${count}-${homeCampus ?? 'sin-campus'}-${lastSync('catalog', { term }) ?? '0'}"`;
  res.set('Cache-Control', 'no-cache');
  res.set('ETag', etag);
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.json(readCatalog(term, { homeCampus }));
});

// "Ver más grupos": trae del portal TODAS las secciones de UNA materia en un
// ciclo y las persiste en el catálogo local. El catálogo se llena por barridos
// de subject que son caros y espaciados, así que lo que la UI muestra es
// siempre una foto vieja: faltan los grupos abiertos después del último
// barrido, que en inscripción son justo los que importan.
//
// Es una sola navegación (syncCatalogCourse, el mismo camino del watcher), no
// un árbol de prefijos: se puede disparar desde la UI sin quemar el
// presupuesto. Devuelve la materia ya releída del catálogo para que la
// pantalla se repinte con los grupos nuevos sin un round-trip extra.
app.post('/api/catalog/course/sync', async (req, res) => {
  const term = req.body?.term ? String(req.body.term) : null;
  const courseCode = req.body?.courseCode ? String(req.body.courseCode).trim().toUpperCase() : '';
  const career = req.body?.career ? String(req.body.career) : 'GRDO';
  if (!term || !courseCode) {
    return res.status(400).json({ error: 'Faltan term o courseCode' });
  }
  try {
    const { saved } = await withPage(req.userId, (page) =>
      syncCatalogCourse(page, { term, career, courseCode })
    );
    const course = readCatalog(term).courses.find((entry) => entry.code === courseCode) ?? null;
    scheduler.emitEvent({
      type: 'log',
      message: `${courseCode}: ${course?.sections.length ?? 0} grupo(s) en el portal para ${term}`,
    });
    res.json({ term, courseCode, saved, course });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
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
    : current?.term ?? latestScheduledTerm(req.userId);
  res.json(readSchedule(req.userId, term));
});

// El refresh en vivo es explícito. Tarda (es Playwright detrás), así que va
// emitiendo pasos por el SSE existente para que el LiveOpBanner los muestre.
app.post('/api/my-schedule/sync', async (req, res) => {
  try {
    // El término lo elige el switcher de /horario: la ETIQUETA del ciclo activo
    // ("Abril de 2026"), porque View My Classes lista los ciclos por etiqueta, no
    // por STRM. Sin él, el sync toma el ciclo que el portal ponga primero (el actual).
    const targetTerm = req.body?.term ? String(req.body.term) : null;
    const schedule = await withPage(req.userId, (page) =>
      syncSchedule(page, {
        userId: req.userId,
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
    markSourceSynced(req.userId, 'mySchedule');
    res.json(readSchedule(req.userId, schedule.term));
  } catch (err) {
    scheduler.emitEvent({ type: 'log', message: `Error leyendo el horario: ${err.message}` });
    res.status(500).json({ error: err.message });
  }
});

// Los plazos de baja por clase, desde cache. Son tres fechas por NRC que dicen
// qué le pasa a tu récord si das de baja HOY: lo único que el calendario
// institucional no puede contestar, porque es por clase y por sesión.
app.get('/api/my-schedule/drop-deadlines', (req, res) => {
  const term = req.query.term ? String(req.query.term) : currentTermCode();
  if (!term) return res.json({ term: null, classes: [], syncedAt: null });
  const classes = readClassDropDeadlines(req.userId, term);
  res.json({
    term,
    classes,
    // La antigüedad viaja con el dato: son plazos que la universidad puede
    // corregir, y el propio portal lo advierte al pie de la pantalla.
    syncedAt: lastSync('enrollmentDeadlines', { userId: req.userId, term }),
  });
});

// Leerlos cuesta una navegación por clase inscrita, así que es explícito y
// nunca automático: no entra al orquestador ni al tick. Con cuatro materias son
// unos cuarenta segundos de Playwright.
app.post('/api/my-schedule/drop-deadlines/sync', async (req, res) => {
  const term = req.body?.term ? String(req.body.term) : currentTermCode();
  if (!term) return res.status(400).json({ error: 'No hay un ciclo en curso del que leer plazos' });
  try {
    const result = await withPage(req.userId, (page) =>
      syncEnrollmentDeadlines(page, {
        userId: req.userId,
        term,
        onStep: (message) => scheduler.emitEvent({ userId: req.userId, type: 'log', message }),
      })
    );
    scheduler.emitEvent({
      userId: req.userId,
      type: 'log',
      message: `Plazos de baja actualizados: ${result.classes.length} clase(s)`,
    });
    res.json({ term, classes: readClassDropDeadlines(req.userId, term), syncedAt: lastSync('enrollmentDeadlines', { userId: req.userId, term }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Única acción destructiva de la app. El contrato exige escribir el código
// exacto; además corre sin retry automático para que un timeout posterior al
// submit no ejecute la baja dos veces.
app.post('/api/my-schedule/drop', async (req, res) => {
  try { requireScraperMutationSupport(); } catch (err) { return res.status(503).json({ error: err.message }); }
  const term = req.body?.term ? String(req.body.term) : null;
  const courseCode = req.body?.courseCode ? String(req.body.courseCode).trim().toUpperCase() : '';
  const classNbr = req.body?.classNbr ? String(req.body.classNbr) : null;
  const confirmCode = req.body?.confirmCode ? String(req.body.confirmCode).trim().toUpperCase() : '';
  if (!term || !courseCode || confirmCode !== courseCode) {
    return res.status(400).json({ error: 'Para dar de baja, escribí el código exacto de la materia' });
  }
  try {
    const result = await withPage(
      req.userId,
      (page) =>
        dropClass(page, {
          term,
          courseCode,
          classNbr,
          onStep: (message) => scheduler.emitEvent({ type: 'log', message }),
        }),
      { retry: false }
    );
    logAction({
      userId: req.userId,
      action: 'drop',
      detail: `${courseCode} (${term})`,
      response: result.message ?? (result.ok ? 'ok' : 'fallo sin mensaje'),
      ok: result.ok,
    });
    if (!result.ok) return res.status(502).json(result);

    // El resultado del Paso 3 confirmó la baja. Se retira del cache local sin
    // depender de que Mi Horario siga ofreciendo ese ciclo inmediatamente.
    removeEnrollmentCourse(req.userId, term, courseCode);
    scheduler.emitEvent({
      type: 'notice',
      title: `${courseCode} fue dada de baja`,
      body: result.message,
      key: `drop:${term}:${courseCode}`,
    });
    res.json({ ...result, schedule: readSchedule(req.userId, term) });
  } catch (err) {
    logAction({ userId: req.userId, action: 'drop', detail: `${courseCode} (${term})`, response: err.message, ok: null });
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
  const courses = readGrades(req.userId);
  res.json({
    generatedAt: new Date().toISOString(),
    syncedAt: lastSync('grades', { userId: req.userId }),
    terms: termSummaries(courses),
    summary: summarizeGrades(courses),
  });
});

app.post('/api/grades/sync', async (req, res) => {
  try {
    const previous = readGrades(req.userId);
    const { courses, mismatches } = await withPage(req.userId, (page) => fetchGrades(page, { userId: req.userId }));
    const published = diffPublishedGrades(previous, courses);
    saveGrades(req.userId, courses);
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
    markSourceSynced(req.userId, 'grades');
    res.json({
      generatedAt: new Date().toISOString(),
      syncedAt: lastSync('grades', { userId: req.userId }),
      terms: termSummaries(readGrades(req.userId)),
      summary: summarizeGrades(readGrades(req.userId)),
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
  const term = planningTerm(req.query.term ? String(req.query.term) : null, latestScheduledTerm(req.userId));
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
       WHERE p.user_id = ?
       ORDER BY p.code`
    )
    .all(req.userId)
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

  res.json({ term, generatedAt: new Date().toISOString(), syncedAt: lastSync('advisement', { userId: req.userId }), courses });
});

app.post('/api/pensum/sync', async (req, res) => {
  try {
    scheduler.emitEvent({ type: 'log', message: 'Generando el informe de avance (tarda: lo arma el portal)…' });
    const { profile, groups, courses } = await withPage(req.userId, (page) => fetchAdvisement(page, { userId: req.userId }));
    // La cohorte (primer término con notas) es de grades, no del informe.
    const saved = saveRequirementTree(
      req.userId,
      { profile, groups, courses },
      { cohortStartTerm: earliestGradeTerm(req.userId) }
    );
    scheduler.emitEvent({
      type: 'log',
      message: `Pénsum actualizado: ${saved.groups} grupos, ${saved.pensum} materia(s)`,
    });
    markSourceSynced(req.userId, 'advisement');
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
  const term = planningTerm(req.query.term ? String(req.query.term) : null, latestScheduledTerm(req.userId));
  const root = readRequirementTree(req.userId);
  if (!root) {
    return res.json({
      term,
      syncedAt: lastSync('advisement', { userId: req.userId }),
      profile: readProfile(req.userId),
      tree: null,
    });
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

  res.json({ term, syncedAt: lastSync('advisement', { userId: req.userId }), profile: readProfile(req.userId), tree: root });
});

app.get('/api/profile', (req, res) => {
  res.json({ profile: readProfile(req.userId), syncedAt: lastSync('advisement', { userId: req.userId }) });
});

// El único campo del perfil que el estudiante escribe: su campus. Ninguna
// pantalla del portal lo publica, así que no se scrapea ni se adivina; null es
// un valor legítimo y significa "todavía no elegí", con el catálogo sin
// reordenar nada.
app.patch('/api/profile', (req, res) => {
  try {
    if (!('homeCampus' in (req.body ?? {}))) throw new Error('Mandá homeCampus para actualizar el perfil');
    setHomeCampus(req.userId, req.body.homeCampus ?? null);
    res.json({ profile: readProfile(req.userId), syncedAt: lastSync('advisement', { userId: req.userId }) });
  } catch (err) {
    res.status(400).json({ error: readableError(err) });
  }
});

// ── Metas y señales (/academico, Fase 10 §12.7) ─────────────────────────────
// El contexto de las metas: los totales del índice (de las notas) y los créditos
// que faltan del pénsum (del árbol de requisitos). Una sola fuente para las
// proyecciones y para cada meta, así ambos miden lo mismo. Todo es cálculo local
// (<10ms), cero PeopleSoft: nunca dispara scraping por entrar a la pantalla.
function goalsContext(userId) {
  const summary = summarizeGrades(readGrades(userId));
  const remainingCredits = readRequirementTree(userId)?.units?.needed ?? 0;
  return { summary, remainingCredits };
}

function goalsResponse(userId) {
  const ctx = goalsContext(userId);
  const hasBasis = ctx.summary.unitsTowardGpa > 0 || ctx.remainingCredits > 0;

  // Los dos horizontes de P5. "Al cerrar este ciclo" solo cuenta los créditos en
  // curso DEL CICLO ACTUAL: sumar todo lo en curso mezclaba cuatrimestres y era
  // lo que inflaba el mejor caso. Y si el acumulado reconstruido no reconcilia
  // con el que publica PeopleSoft, `horizons` vuelve sin números — la UI no
  // tiene que acordarse de esconderlos.
  // Entre ciclos no hay "este ciclo", pero sí puede haber materias inscritas
  // del que viene: el horizonte corto se ancla al ciclo que REALMENTE tiene los
  // créditos en curso. Sin esto la pantalla decía "EN CURSO 4 créditos" arriba y
  // "no tenés materias en curso en este ciclo" abajo, sobre los mismos datos.
  const terms = readTerms();
  const courses = readGrades(userId);
  const shortHorizonTerm =
    [terms.current?.label, terms.next?.label]
      .filter(Boolean)
      .find((label) => creditsInProgressFor(courses, label) > 0) ??
    terms.current?.label ??
    terms.next?.label ??
    null;

  const horizons = buildProjection({
    official: readOfficialTotals(userId),
    reconstructed: ctx.summary,
    currentTermCredits: creditsInProgressFor(courses, shortHorizonTerm),
    remainingCredits: ctx.remainingCredits,
    currentTermLabel: shortHorizonTerm,
  });

  return {
    goals: goals.evaluateGoals(goals.listGoals(userId), ctx),
    projection: hasBasis ? projectFinalGpa(ctx.summary, ctx.remainingCredits) : null,
    horizons,
    basedOn: {
      gpa: ctx.summary.gpa,
      unitsTowardGpa: ctx.summary.unitsTowardGpa,
      remainingCredits: ctx.remainingCredits,
    },
    syncedAt: lastSync('grades', { userId }),
  };
}

app.get('/api/goals', (req, res) => res.json(goalsResponse(req.userId)));

// Las mutaciones devuelven la respuesta entera (metas + proyección reevaluadas):
// la UI reemplaza el cache de un solo golpe, sin un segundo fetch.
app.post('/api/goals', (req, res) => {
  try {
    goals.createGoal(req.userId, { kind: req.body?.kind ?? 'gpa', target: req.body?.target, deadlineTerm: req.body?.deadlineTerm });
    res.json(goalsResponse(req.userId));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/goals/:id', (req, res) => {
  try {
    goals.updateGoal(req.userId, Number(req.params.id), { target: req.body?.target, deadlineTerm: req.body?.deadlineTerm });
    res.json(goalsResponse(req.userId));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/goals/:id', (req, res) => {
  try {
    goals.deleteGoal(req.userId, Number(req.params.id));
    res.json(goalsResponse(req.userId));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Señales descriptivas del histórico. Solo salen las que pasan su umbral de
// datos (shared/insights.ts); un arreglo vacío es "todavía no hay qué decir".
app.get('/api/insights', (req, res) => {
  const courses = readGrades(req.userId);
  res.json({ insights: computeInsights(termSummaries(courses), courses), syncedAt: lastSync('grades', { userId: req.userId }) });
});

// Los códigos que le importan a TU carrera: todo lo del árbol de requisitos
// (obligatorias + candidatas de electiva) más lo que ya tenés inscrito. Es lo
// que acota la búsqueda carrera-first (§11): el índice arranca por acá y el chip
// "Todo el catálogo" abre el resto.
app.get('/api/pensum/codes', (req, res) => {
  const reqCodes = requirementCodes(req.userId);
  const enrolled = db
    .prepare(
      `SELECT DISTINCT c.code FROM enrollments e JOIN courses c ON c.id = e.course_id
       WHERE e.status = 'enrolled' AND e.user_id = ?`
    )
    .all(req.userId)
    .map((r) => r.code);
  res.json({ codes: [...new Set([...reqCodes, ...enrolled])] });
});

// Recordatorio antes de clase. Todo el dato ya está en disco: este endpoint no
// toca PeopleSoft, solo lee tu horario y dice qué viene.
app.get('/api/class-reminders', (req, res) => {
  res.json(reminderStatus(req.userId));
});

app.patch('/api/class-reminders', (req, res) => {
  try {
    setReminderSettings({ enabled: req.body?.enabled, leadMinutes: req.body?.leadMinutes });
    res.json(reminderStatus(req.userId));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// El ritmo de cupo de unas secciones concretas (feature nueva). Sale de la
// serie `seats_snapshot` que la app ya venía guardando y nunca leía más allá de
// la última fila. Es cálculo local sobre disco: no toca el portal.
app.get('/api/seat-trend', (req, res) => {
  const term = req.query.term ? String(req.query.term) : null;
  const classNbrs = String(req.query.classNbrs ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 40);
  if (!term || !classNbrs.length) return res.json({ term, trends: {} });

  const history = seatHistory(term, classNbrs);
  const trends = {};
  for (const classNbr of classNbrs) {
    const trend = seatTrend(history.get(classNbr) ?? []);
    trends[classNbr] = {
      samples: trend.samples,
      change: trend.change,
      perHour: trend.perHour,
      direction: trend.direction,
      windowHours: trend.windowHours,
      closedAt: trend.closedAt,
      reopenedAt: trend.reopenedAt,
      summary: describeTrend(trend),
      latestAt: trend.latest?.capturedAt ?? null,
      seatsOpen: trend.latest?.seatsOpen ?? null,
    };
  }
  res.json({ term, trends });
});

// El calendario académico oficial. Sale de SQLite (<10ms) y trae su antigüedad:
// si el último fetch falló, la pantalla muestra lo cacheado diciendo de cuándo
// es, en vez de quedarse vacía.
app.get('/api/academic-calendar', (req, res) => {
  const limit = Number(req.query.limit);
  const past = Number(req.query.pasados);
  res.json(
    readCalendar({
      limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 5,
      past: Number.isInteger(past) && past >= 0 ? Math.min(past, 20) : 3,
    })
  );
});

app.get('/api/holds', (req, res) => {
  res.json({
    generatedAt: new Date().toISOString(),
    syncedAt: lastSync('holds', { userId: req.userId }),
    holds: readHolds(req.userId),
  });
});

app.post('/api/holds/sync', async (req, res) => {
  try {
    const parsed = await withPage(req.userId, (page) => fetchHolds(page, { userId: req.userId }));
    saveHolds(req.userId, parsed.holds);
    scheduler.emitEvent({
      type: 'log',
      message: parsed.holds.length ? `${parsed.holds.length} hold(s) activos` : 'Sin holds ni pendientes',
    });
    markSourceSynced(req.userId, 'holds');
    res.json({
      generatedAt: new Date().toISOString(),
      syncedAt: lastSync('holds', { userId: req.userId }),
      holds: readHolds(req.userId),
      todos: parsed.todos,
    });
  } catch (err) {
    scheduler.emitEvent({ type: 'log', message: `Error leyendo los holds: ${err.message}` });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/enroll', async (req, res) => {
  try {
    requireScraperMutationSupport();
    const result = await scheduler.runEnrollNow(req.userId, 'manual');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/search/options', async (req, res) => {
  try {
    const options = await withPage(req.userId, (page) => getSearchFormOptions(page));
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
    const rows = await withPage(req.userId, (page) => searchClasses(page, { term, career, courseNumber }));
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
    const result = await withPage(req.userId, (page) =>
      addExactSectionToCart(page, { term, career, courseNumber, classNbr, relatedClassNbr })
    );
    logAction({
      userId: req.userId,
      action: 'add-to-cart',
      detail: `${career} ${courseNumber} · NRC ${classNbr} (${term})`,
      response: result.alreadyInCart
        ? 'ya estaba en el carrito'
        : result.autoPicked
          ? `agregada al carrito · el portal eligió la práctica: ${result.autoPicked}`
          : 'agregada al carrito',
      ok: true,
    });
    // Que el portal haya elegido la práctica no es un detalle de log: cambia el
    // horario que vas a cursar, así que se anuncia donde se ve.
    if (result.autoPicked) {
      scheduler.emitEvent({
        userId: req.userId,
        type: 'log',
        message: `⚠ No elegiste práctica para ${courseNumber}: el portal marcó ${result.autoPicked}`,
      });
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Mesa de inscripción ─────────────────────────────────────────────────────
// La pantalla que decide qué materias inscribir. Endpoint compuesto: lo ya
// inscrito, lo pendiente que se oferta, la selección viva, la fase del ciclo y
// la antigüedad del cupo llegan juntos, porque juntos es como significan algo.
// Todo es lectura local sobre SQLite; nada de acá toca el portal.

app.get('/api/mesa', (req, res) => {
  try {
    const term = planningTerm(req.query.term ? String(req.query.term) : null, latestScheduledTerm(req.userId));
    // `plan` explícito es el que la etapa de grupos está armando. Sin él se cae
    // en el plan del ciclo, que es lo que la mesa hacía cuando era su propia
    // pantalla.
    const planId = Number(req.query.plan);
    res.json(readMesa(req.userId, term, { planId: Number.isSafeInteger(planId) && planId > 0 ? planId : null }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Elegir (o cambiar) la sección de una materia. Es idempotente por materia: el
// mismo PUT dos veces deja el mismo estado, que es lo que hace que la UI pueda
// mandar el estado completo del control sin llevar la cuenta de si ya existía.
app.put('/api/mesa/seleccion', (req, res) => {
  try {
    const term = planningTerm(req.body?.term ? String(req.body.term) : null, latestScheduledTerm(req.userId));
    const courseId = Number(req.body?.courseId);
    const sectionId = req.body?.sectionId == null ? null : Number(req.body.sectionId);
    const relatedSectionId = req.body?.relatedSectionId == null ? null : Number(req.body.relatedSectionId);
    if (!Number.isInteger(courseId)) throw new Error('Falta la materia');

    const plan = mesaPlan(req.userId, term, { create: true });
    const existing = plan.items.find((item) => item.courseId === courseId);
    if (existing) {
      plans.updatePlanItem(req.userId, plan.id, existing.id, { sectionId, relatedSectionId });
    } else {
      plans.addPlanItem(req.userId, plan.id, { courseId, sectionId, relatedSectionId });
    }
    res.json(readMesa(req.userId, term));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/mesa/seleccion/:courseId', (req, res) => {
  try {
    const term = planningTerm(req.query.term ? String(req.query.term) : null, latestScheduledTerm(req.userId));
    const plan = mesaPlan(req.userId, term);
    const item = plan?.items.find((entry) => entry.courseId === Number(req.params.courseId));
    // Quitar algo que no está no es un error: la UI puede reintentar sin que la
    // pantalla se llene de mensajes que no significan nada.
    if (item) plans.removePlanItem(req.userId, plan.id, item.id);
    res.json(readMesa(req.userId, term));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Arma combinaciones con las condiciones DURAS del estudiante. Las condiciones
// no penalizan un horario: lo eliminan, y por eso la respuesta trae `blocked`,
// las materias que se quedaron sin ninguna sección posible. Sin eso la pantalla
// diría "no hay combinación" sin decir qué aflojar.
app.post('/api/mesa/armar', (req, res) => {
  try {
    const term = planningTerm(req.body?.term ? String(req.body.term) : null, latestScheduledTerm(req.userId));
    const mesa = readMesa(req.userId, term);
    const wanted = new Set((req.body?.courseIds ?? []).map(Number));
    const pool = wanted.size ? mesa.candidates.filter((course) => wanted.has(course.courseId)) : mesa.candidates;

    const constraints = { ...NO_CONSTRAINTS, ...(req.body?.constraints ?? {}) };
    const courses = pool.map((course) => ({
      courseId: course.courseId,
      code: course.code,
      title: course.title,
      // Solo los teóricos entran al solver: la práctica se elige después,
      // contra el horario que la teórica ya fijó. Meterlas juntas multiplicaría
      // el árbol por combinaciones que el portal ni siquiera acepta sueltas.
      sections: lectureSections(course.sections)
        .map((section) => ({
          id: section.id,
          courseId: course.courseId,
          code: course.code,
          title: course.title,
          classNbr: section.classNbr,
          section: section.section,
          component: section.component,
          instructor: section.instructor,
          meetings: section.meetings,
          campus: section.campus,
        })),
    }));

    // Lo ya inscrito no se negocia: entra como una materia de una sola sección
    // para que ninguna combinación propuesta choque con lo que ya tenés.
    const locked = mesa.enrolled.flatMap((course) =>
      course.sections.map((section) => ({
        courseId: -course.id,
        code: course.code,
        title: course.title,
        sections: [
          {
            id: section.id,
            courseId: -course.id,
            code: course.code,
            title: course.title,
            classNbr: section.classNbr,
            section: section.section,
            component: section.component,
            instructor: section.instructor,
            meetings: section.meetings,
            campus: section.campus ?? null,
          },
        ],
      }))
    );

    const solved = solveCombinations([...locked, ...courses], {
      constraints,
      limit: Number(req.body?.limit ?? 5000),
    });

    res.json({
      term,
      constraints,
      truncated: solved.truncated,
      blocked: solved.blocked,
      dropped: solved.dropped,
      // Las secciones de lo ya inscrito se quitan de la propuesta: entraron
      // solo para que el choque se calcule bien, no son algo que elegir.
      combinations: solved.combinations.slice(0, 20).map((combo) => ({
        penalty: combo.penalty,
        metrics: combo.metrics,
        sections: combo.sections.filter((section) => section.courseId > 0),
      })),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Planes ──────────────────────────────────────────────────────────────────
// CRUD puro sobre SQLite (<10ms): nada de esto toca el portal. La única
// operación viva de un plan es mandarlo al carrito (más abajo).
// Los errores de src/plans.js son de datos del usuario (plan inexistente,
// materia duplicada, sección de otro término) → 400 con el mensaje tal cual.

// Los controles del recomendador viajan por query/body y NO se persisten: son
// una pregunta ("¿y si tomo 12 créditos y dejo Física para después?"), no una
// configuración. Lista separada por comas para que la URL siga siendo
// compartible y el estado de la pantalla viva ahí.
function recommendationOptionsFrom(source) {
  const codes = (value) =>
    String(value ?? '')
      .split(',')
      .map((code) => code.trim().toUpperCase())
      .filter(Boolean);
  const strategy = STRATEGIES.includes(source?.strategy) ? source.strategy : 'ponerse-al-dia';
  return {
    maxCredits: source?.maxCredits ?? DEFAULT_MAX_CREDITS,
    strategy,
    include: codes(source?.include),
    exclude: codes(source?.exclude),
  };
}

// Las DOS propuestas del ciclo (ponerse al día / avanzar) con el porqué de cada
// materia y, sobre todo, lo que NO se puede proponer y por qué falta.
app.get('/api/recommendation', (req, res) => {
  try {
    const term = planningTerm(req.query.term ? String(req.query.term) : null, latestScheduledTerm(req.userId));
    res.json(recommendationOptions(req.userId, term, recommendationOptionsFrom(req.query)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// La ruta a graduación. Cálculo local sobre el árbol de requisitos y el plan
// oficial: nunca sale al portal, así que abrir la pantalla no cuesta una sesión
// de Playwright. El ciclo de arranque es el próximo a inscribir; si no hay uno
// resuelto, la ruta se traza igual y sale sin fechas.
app.get('/api/degree-path', (req, res) => {
  try {
    const terms = readTerms();
    const maxCredits = Number(req.query.maxCredits ?? DEFAULT_MAX_CREDITS);
    const startTerm = terms.next?.label ?? terms.current?.label ?? null;
    res.json({
      ...degreePathFor(req.userId, { maxCredits, startTerm }),
      startTerm,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/recommendation/plan', (req, res) => {
  try {
    const term = planningTerm(req.body?.term ? String(req.body.term) : null, latestScheduledTerm(req.userId));
    const proposal = recommendationForTerm(req.userId, term, recommendationOptionsFrom(req.body));
    if (!proposal.schedule.valid || proposal.recommendations.length === 0) {
      throw new Error(proposal.caveats[0] ?? 'No hay una combinación recomendada para este ciclo');
    }
    const detail = plans.createPlanWithItems(req.userId, {
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
  res.json({ plans: plans.listPlans(req.userId) });
});

app.post('/api/plans', (req, res) => {
  try {
    res.json(plans.createPlan(req.userId, req.body ?? {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/plans/:id', (req, res) => {
  try {
    res.json(plans.readPlan(req.userId, Number(req.params.id)));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.patch('/api/plans/:id', (req, res) => {
  try {
    res.json(plans.updatePlan(req.userId, Number(req.params.id), req.body ?? {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/plans/:id', (req, res) => {
  try {
    plans.deletePlan(req.userId, Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/plans/:id/duplicate', (req, res) => {
  try {
    res.json(plans.duplicatePlan(req.userId, Number(req.params.id)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/plans/:id/items', (req, res) => {
  try {
    res.json(plans.addPlanItem(req.userId, Number(req.params.id), req.body ?? {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/plans/:id/items/:itemId', (req, res) => {
  try {
    res.json(plans.updatePlanItem(req.userId, Number(req.params.id), Number(req.params.itemId), req.body ?? {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/plans/:id/items/:itemId', (req, res) => {
  try {
    res.json(plans.removePlanItem(req.userId, Number(req.params.id), Number(req.params.itemId)));
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
  try { requireScraperMutationSupport(); } catch (err) { return res.status(503).json({ error: err.message }); }
  let plan;
  try {
    plan = plans.readPlan(req.userId, Number(req.params.id));
  } catch (err) {
    return res.status(404).json({ error: err.message });
  }
  const items = plan.items.filter((item) => item.section);
  if (items.length === 0) {
    return res.status(400).json({ error: 'El plan no tiene materias con grupo elegido' });
  }

  const results = await withPage(req.userId, async (page) => {
    const out = [];
    for (const item of items) {
      // La práctica viaja pegada a su teórica en el mismo pedido: la pantalla
      // del portal las agrega juntas, con un radio para el componente
      // relacionado. Mandar solo la teórica dejaba que PeopleSoft eligiera la
      // práctica por su cuenta, y el horario inscrito no era el planeado.
      const relatedClassNbr = item.relatedSection?.classNbr ?? null;
      const etiqueta = relatedClassNbr
        ? `${item.section.classNbr} + ${relatedClassNbr}`
        : item.section.classNbr;
      scheduler.emitEvent({
        type: 'log',
        message: `Agregando ${item.title} (${item.code} · ${etiqueta}) al carrito…`,
      });
      try {
        const r = await addExactSectionToCart(page, {
          term: plan.term,
          career: item.career ?? 'GRDO',
          courseNumber: portalCatalogNbr(item),
          classNbr: item.section.classNbr,
          relatedClassNbr,
        });
        const alreadyInCart = !!r.alreadyInCart;
        logAction({
          userId: req.userId,
          action: 'add-to-cart',
          detail: `${item.code} · NRC ${etiqueta} (${plan.term})`,
          response: alreadyInCart
            ? 'ya estaba en el carrito'
            : r.autoPicked
              ? `agregada al carrito · el portal eligió la práctica: ${r.autoPicked}`
              : 'agregada al carrito',
          ok: true,
        });
        if (r.autoPicked) {
          scheduler.emitEvent({
            userId: req.userId,
            type: 'log',
            message: `⚠ ${item.title} no tenía práctica elegida: el portal marcó ${r.autoPicked}`,
          });
        }
        out.push({ itemId: item.id, code: item.code, title: item.title, ok: true, alreadyInCart, error: null });
        scheduler.emitEvent({
          type: 'log',
          message: alreadyInCart ? `${item.title}: ya estaba en el carrito` : `${item.title}: agregada al carrito ✓`,
        });
      } catch (err) {
        logAction({
          userId: req.userId,
          action: 'add-to-cart',
          detail: `${item.code} · NRC ${etiqueta} (${plan.term})`,
          response: err.message,
          ok: false,
        });
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
  res.json(scheduler.getState(req.userId));
});

// El Historial de Ajustes (§8): qué hizo mikampus sobre tu matrícula y qué
// contestó el portal, literal.
app.get('/api/actions', (req, res) => {
  res.json({ actions: readActions(req.userId) });
});

app.post('/api/schedule', (req, res) => {
  try {
    requireScraperMutationSupport();
    const at = new Date(req.body?.atISO).getTime();
    if (Number.isNaN(at) || at <= Date.now()) throw new Error('La hora debe ser futura y válida');
    authorizeUnattendedCredential(req.userId, {
      consent: req.body?.consent,
      term: req.body?.term,
      reason: 'disparo programado',
    });
    scheduler.scheduleFixedTime(req.userId, req.body.atISO);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/schedule', (req, res) => {
  scheduler.cancelSchedule(req.userId);
  revokeUnattendedCredentialIfUnused(req.userId);
  res.json({ ok: true });
});

app.post('/api/watch', (req, res) => {
  try {
    const {
      enabled,
      autoEnroll = false,
      appointmentAt = null,
      term,
      consent = false,
      scope = scheduler.DEFAULT_WATCHER_SCOPE,
      intervalMs,
    } = req.body ?? {};
    // El ritmo se aplica antes de arrancar para que el primer tick ya use el
    // valor nuevo, y también cuando se apaga: quedarse con la preferencia
    // guardada es lo esperable al volver a encenderlo.
    if (intervalMs !== undefined) scheduler.setWatcherTickMs(intervalMs);
    if (enabled) {
      if (!scheduler.WATCHER_SCOPES.includes(scope)) throw new Error(`Alcance de watcher desconocido: ${scope}`);
      if (autoEnroll) requireScraperMutationSupport();
      // La razón queda escrita junto a la credencial guardada: si alguien abre
      // Ajustes en dos meses, tiene que poder leer para qué la autorizó.
      authorizeUnattendedCredential(req.userId, {
        consent,
        term,
        reason: autoEnroll
          ? `watcher con auto-inscripción (${scheduler.WATCHER_SCOPE_LABELS[scope]})`
          : `watcher (${scheduler.WATCHER_SCOPE_LABELS[scope]}, solo notificar)`,
      });
      const parsedAppointment = appointmentAt ? new Date(appointmentAt) : null;
      if (appointmentAt && Number.isNaN(parsedAppointment.getTime())) throw new Error('La hora de inscripción no es válida');
      scheduler.startWatcher(req.userId, {
        autoEnroll: Boolean(autoEnroll),
        appointmentAt: parsedAppointment?.toISOString() ?? null,
        scope,
      });
    } else {
      scheduler.stopWatcher(req.userId);
      revokeUnattendedCredentialIfUnused(req.userId);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Solo el ritmo, sin tocar el encendido ni la autorización. Cambiar cada cuánto
// se consulta no eleva permisos —no guarda credencial ni habilita
// auto-inscripción—, así que no tiene por qué pasar por el consentimiento que
// exige encender el watcher.
app.patch('/api/watch', (req, res) => {
  try {
    const tickMs = scheduler.setWatcherTickMs(req.body?.intervalMs);
    res.json({ ok: true, intervalMs: tickMs, state: scheduler.getState(req.userId) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('retry: 2000\n\n');

  // Un evento personal (lleva userId) solo va al SSE de su dueño; los de la
  // app entera (sin userId) los ven todos.
  const send = (event) => {
    if (event.userId != null && event.userId !== req.userId) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
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

// El core local nunca escucha la LAN. El modo Home Server se introducirá como
// host separado, con pairing y TLS explícitos; HOST no es un escape hatch.
const HOST = '127.0.0.1';

// Cruza los términos que ya están en disco (STRM inscritos + etiquetas de
// grades) al arrancar, para que el modelo de tiempo esté al día sin esperar a
// una sync. Es barato: son pocas filas y upserts idempotentes.
reconcileTerms();
// Antes de cualquier evento notificable: el modo guardado gobierna el proceso.
const bootMode = publishRuntimeMode();
if (bootMode) console.log(`[agent] modo de runtime: ${bootMode}`);
const runtimeStart = recordRuntimeStart();
// Higiene al arrancar: sesiones vencidas fuera, credenciales vencidas fuera.
auth.purgeExpiredSessions();
purgeExpiredCredentials();
// Los disparos y watchers persistidos se rearman: el reboot de las 5:59 no
// puede costar el cupo de las 6:00.
const timers = scheduler.restoreTimers();
if (timers.schedules || timers.watchers) {
  console.log(`[scheduler] restaurado: ${timers.schedules} disparo(s), ${timers.watchers} watcher(s)`);
}
if (runtimeStart.hadGap) console.warn('[agent] se registró un intervalo no vigilado; el watcher hará una consulta fresca');
// Nunca reintenta un submit incierto: solo refresca el estado real del portal.
scheduler.reconcileUncertainSchedules().catch((error) => console.warn(`[scheduler] no se pudo reconciliar un submit incierto: ${error.message}`));

try {
  acquireAgentLock({ port: PORT });
} catch (error) {
  console.error(`[agent] ${error.message}`);
  process.exit(1);
}

const server = app.listen(PORT, HOST, () => {
  console.log(`mikampus en http://localhost:${PORT}`);
  // El catálogo del portal llega sin créditos y, hasta que corra el sync de
  // títulos, con el código en lugar del nombre. El plan académico oficial tiene
  // los dos. Se completan al arrancar para que el plan recomendado no diga
  // "ICC-471, 0 créditos" donde debería decir "Gestión de Proyectos, 4".
  const plan = planForUser(LOCAL_USER_ID);
  if (plan) {
    const { credits, titles } = applyPlanFacts(plan);
    if (credits || titles) {
      console.log(`[catálogo] desde el plan ${plan.plan}: ${credits} crédito(s) y ${titles} título(s) completados`);
    }
  }
  // Apagado salvo que CATALOG_CRON_AT diga a qué hora (ver src/cron.js).
  startCatalogCron();
  startBackupCron();
  // El tick liviano de P1: cada minuto pregunta a SQLite si algo venció. Sin
  // sesión viva no sale al portal — la fuente queda `paused` con su último dato.
  startSyncLoop(LOCAL_USER_ID);
  // El aviso antes de clase corre en el agente, no en la pestaña: el sentido
  // entero es que llegue con el navegador cerrado.
  startClassReminders(LOCAL_USER_ID);
});
server.on('error', (error) => {
  releaseAgentLock();
  console.error(`[agent] no se pudo abrir ${HOST}:${PORT}: ${error.message}`);
  process.exit(1);
});

// Cuánto se espera a que el servidor cierre solo antes de forzar la salida. No
// es paranoia: `server.close()` solo llama a su callback cuando NO queda una
// sola conexión abierta, y el feed de actividad es SSE, o sea una conexión que
// por diseño no termina. Con una pestaña abierta el agente recibía la señal, se
// quedaba esperando para siempre y no había forma de reiniciarlo: `stop`
// reportaba que no se detuvo y el arranque siguiente chocaba con su propio lock.
const SHUTDOWN_GRACE_MS = 5_000;

let apagando = false;

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    // Una segunda señal mientras se apaga significa "ya, ahora": el operador no
    // tiene que buscar el PID para mandar un KILL.
    if (apagando) return process.exit(0);
    apagando = true;

    stopCatalogCron();
    stopBackupCron();
    stopSyncLoop();
    stopClassReminders();
    await shutdown();

    const cerrar = () => {
      releaseAgentLock();
      recordRuntimeStop();
      process.exit(0);
    };
    const forzar = setTimeout(cerrar, SHUTDOWN_GRACE_MS);
    forzar.unref();

    server.close(cerrar);
    // Los SSE vivos se cortan a mano: son la razón por la que close() no vuelve.
    // El cliente reconecta solo cuando el agente esté de nuevo arriba.
    server.closeAllConnections?.();
  });
}
