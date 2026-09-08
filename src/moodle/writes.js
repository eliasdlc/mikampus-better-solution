import { db } from '../db.js';
import { callPva, uploadPva } from './session.js';
import { saveSubmissionStatus } from './assignments.js';
import { nowSeconds, int, text } from './shape.js';

// Lo único de este proyecto que no se puede deshacer.
//
// Todo lo demás lee la PVA y guarda una copia; acá se le escribe a la
// plataforma donde el estudiante se juega la nota. Las reglas no son una
// advertencia al costado, son el diseño del módulo:
//
//   1. Ninguna escritura automática. No hay origen 'auto': quien llama declara
//      'web', 'mcp' o 'cli', y los tres nacen de una acción de la persona en
//      ese momento. Ningún módulo del sync importa este archivo, y
//      scripts/test-pva-escritura.mjs lo verifica sobre el grafo de imports.
//   2. Guardar y entregar son dos pasos distintos SOLO cuando la tarea los
//      tiene. Con `submissiondrafts = 0` (las 17 tareas vistas, MAPA §3.9) no
//      existe borrador: guardar YA es entregar, y entonces guardar exige la
//      misma confirmación escrita que entregar.
//   3. Nada viaja sin que se pueda ver antes: `previewSubmission` devuelve el
//      payload exacto, y `dryRun` lo asienta sin mandarlo.
//   4. Toda intención queda en `pva_write`, incluidas las rechazadas y los
//      ensayos.
//
// Y una precaución que sale del recon: la forma de la respuesta de las cuatro
// funciones de escritura NO está verificada contra esta instancia (MAPA
// §"hueco de escritura"). Por eso ninguna decisión se toma con lo que
// devuelven: después de escribir se vuelve a pedir el estado real de la
// entrega, y eso es lo que se guarda.

const ORIGINS = new Set(['web', 'mcp', 'cli']);

// La declaración de autoría es un ajuste de SITIO y ninguna función volcada lo
// expone (MAPA §3.9). Cuando una tarea la exige, se muestra este texto y se
// dice de dónde sale, en vez de inventar el de la plataforma.
export const STATEMENT_FALLBACK =
  'Esta tarea exige aceptar la declaración de autoría de la PVA. mikampus no puede leer su texto: leelo en la plataforma antes de aceptar.';

function assertOrigin(origin) {
  if (!ORIGINS.has(origin)) {
    throw new Error(`Origen de escritura inválido: ${origin}. Toda escritura nace de una acción de la persona.`);
  }
}

/** Compara lo que la persona escribió con el nombre de la tarea. */
function sameName(typed, real) {
  const normal = (value) =>
    String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  return normal(typed).length > 0 && normal(typed) === normal(real);
}

// ── El libro de escrituras ─────────────────────────────────────────────────

function record({
  userId,
  kind,
  wsfunction,
  courseId = null,
  assignmentId = null,
  discussionId = null,
  targetName,
  preview,
  dryRun = false,
  origin,
  status,
  errorcode = null,
  response = null,
  now = Date.now(),
}) {
  const info = db
    .prepare(
      `INSERT INTO pva_write
         (user_id, kind, wsfunction, course_id, assignment_id, discussion_id, target_name,
          preview, dry_run, origin, status, errorcode, response, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      kind,
      wsfunction,
      courseId,
      assignmentId,
      discussionId,
      targetName,
      JSON.stringify(preview),
      dryRun ? 1 : 0,
      origin,
      status,
      errorcode,
      response == null ? null : String(response).slice(0, 4000),
      nowSeconds(now)
    );
  return Number(info.lastInsertRowid);
}

/** Lo que mikampus escribió (o intentó escribir) en la PVA, de lo nuevo a lo viejo. */
export function recentWrites(userId, { limit = 20 } = {}) {
  return db
    .prepare(
      `SELECT write_id AS writeId, kind, wsfunction, course_id AS courseId, assignment_id AS assignmentId,
              discussion_id AS discussionId, target_name AS targetName, preview, dry_run AS dryRun,
              origin, status, errorcode, response, created_at AS createdAt
       FROM pva_write WHERE user_id = ? ORDER BY write_id DESC LIMIT ?`
    )
    .all(userId, limit)
    .map((row) => ({
      ...row,
      dryRun: row.dryRun === 1,
      preview: JSON.parse(row.preview),
      createdAt: new Date(row.createdAt * 1000).toISOString(),
    }));
}

// ── La tarea, con todo lo que decide si se puede escribir ───────────────────

/** La tarea, su configuración de plugins y el estado de la última entrega. */
export function assignmentForWrite(userId, assignmentId) {
  const assignment = db
    .prepare(
      `SELECT assignment_id AS assignmentId, cmid, course_id AS courseId, name, duedate, cutoffdate,
              allowsubmissionsfromdate AS opensAt, nosubmissions AS noSubmissions,
              submissiondrafts AS submissionDrafts, requiresubmissionstatement AS requiresStatement,
              maxattempts AS maxAttempts, teamsubmission AS teamSubmission
       FROM pva_assignment WHERE user_id = ? AND assignment_id = ?`
    )
    .get(userId, assignmentId);
  if (!assignment) return null;

  const config = new Map(
    db
      .prepare('SELECT subtype, plugin, name, value FROM pva_assignment_config WHERE assignment_id = ?')
      .all(assignmentId)
      .map((row) => [`${row.subtype}:${row.plugin}:${row.name}`, row.value])
  );
  const submission = db
    .prepare(
      `SELECT status, attemptnumber, grading_status AS gradingStatus, can_edit AS canEdit,
              extensionduedate AS extensionAt, timemodified AS submittedAt
       FROM pva_submission WHERE user_id = ? AND assignment_id = ? AND is_latest = 1`
    )
    .get(userId, assignmentId);

  // `configs[].value` es SIEMPRE string (MAPA §3.9): castear antes de comparar
  // con el archivo de la persona, o "500000000" > 5 es falso por alfabético.
  const number = (key, fallback) => {
    const raw = config.get(key);
    const value = raw == null ? Number.NaN : Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  const enabled = (plugin) => config.get(`assignsubmission:${plugin}:enabled`) === '1';
  const types = String(config.get('assignsubmission:file:filetypeslist') ?? '')
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  return {
    ...assignment,
    submission: submission ?? null,
    plugins: {
      onlineText: {
        enabled: enabled('onlinetext'),
        wordLimit: number('assignsubmission:onlinetext:wordlimit', 0),
      },
      file: {
        enabled: enabled('file'),
        maxFiles: number('assignsubmission:file:maxfilesubmissions', 1),
        // El tope por archivo de la entrega, que no es el `userquota` del área
        // privada: son dos límites independientes y hay que mirar los dos.
        maxBytes: number('assignsubmission:file:maxsubmissionsizebytes', 0),
        // Lista vacía = cualquier extensión.
        types,
      },
    },
  };
}

const iso = (seconds) => (seconds == null || seconds === 0 ? null : new Date(seconds * 1000).toISOString());

/**
 * Exactamente qué va a viajar, antes de que viaje.
 *
 * `blockers` es lo que impide mandar; `warnings` es lo que hay que saber y no
 * impide nada. La pantalla muestra los dos: una entrega tarde es legítima y
 * una entrega después del cierre duro no existe.
 */
export function previewSubmission(
  userId,
  assignmentId,
  // `purpose` separa las dos preguntas: guardar mira además QUÉ se manda,
  // entregar solo mira si la ventana y el estado lo permiten.
  { body = '', files = [], now = Date.now(), purpose = 'guardar' } = {}
) {
  const assignment = assignmentForWrite(userId, assignmentId);
  if (!assignment) return null;
  const seconds = nowSeconds(now);
  const blockers = [];
  const warnings = [];

  const closesAt = assignment.submission?.extensionAt ?? assignment.cutoffdate ?? null;
  if (assignment.noSubmissions === 1) blockers.push('Esta tarea no recibe entregas en línea.');
  if (assignment.teamSubmission === 1) {
    warnings.push('Es una entrega de grupo: lo que mandes cuenta para todo el grupo.');
  }
  if (assignment.opensAt && seconds < assignment.opensAt) {
    blockers.push(`Todavía no abre: acepta entregas desde ${iso(assignment.opensAt)}.`);
  }
  if (closesAt && seconds > closesAt) {
    blockers.push(`El cierre duro ya pasó (${iso(closesAt)}): la plataforma no va a aceptar nada.`);
  } else if (assignment.duedate && seconds > assignment.duedate) {
    warnings.push('La fecha de entrega ya pasó: va a quedar marcada como tarde.');
  }
  if (assignment.submission?.status === 'submitted' && assignment.submission?.canEdit !== 1) {
    blockers.push('Ya está entregada y el profesor no dejó reabrirla.');
  }

  const cuerpo = String(body ?? '').trim();
  if (cuerpo && !assignment.plugins.onlineText.enabled) {
    blockers.push('Esta tarea no acepta texto en línea, solo archivos.');
  }
  const limite = assignment.plugins.onlineText.wordLimit;
  if (cuerpo && limite > 0) {
    const palabras = cuerpo.split(/\s+/).filter(Boolean).length;
    if (palabras > limite) blockers.push(`El texto tiene ${palabras} palabras y el límite es ${limite}.`);
  }

  if (files.length && !assignment.plugins.file.enabled) blockers.push('Esta tarea no acepta archivos.');
  if (files.length > assignment.plugins.file.maxFiles) {
    blockers.push(`Acepta ${assignment.plugins.file.maxFiles} archivo(s) y le estás mandando ${files.length}.`);
  }
  for (const file of files) {
    const bytes = file.bytes?.byteLength ?? file.bytes?.length ?? 0;
    if (assignment.plugins.file.maxBytes > 0 && bytes > assignment.plugins.file.maxBytes) {
      blockers.push(`${file.name} pesa ${bytes} bytes y el máximo por archivo es ${assignment.plugins.file.maxBytes}.`);
    }
    const extension = String(file.name ?? '').split('.').pop()?.toLowerCase() ?? '';
    const permitidas = assignment.plugins.file.types;
    if (permitidas.length && !permitidas.some((tipo) => tipo.replace(/^\./, '') === extension)) {
      blockers.push(`${file.name} no está entre las extensiones permitidas (${permitidas.join(', ')}).`);
    }
  }
  if (purpose === 'guardar' && !cuerpo && files.length === 0) blockers.push('No hay nada que mandar: ni texto ni archivos.');

  // Sin etapa de borrador, guardar ES entregar. Es la diferencia entre un
  // botón que se puede deshacer y uno que no.
  const drafts = assignment.submissionDrafts === 1;
  return {
    assignment: {
      assignmentId: assignment.assignmentId,
      courseId: assignment.courseId,
      cmid: assignment.cmid,
      name: assignment.name,
      dueAt: iso(assignment.duedate),
      closesAt: iso(closesAt),
      opensAt: iso(assignment.opensAt),
    },
    // Lo que la plataforma va a recibir, campo por campo.
    sends: {
      onlineText: cuerpo || null,
      files: files.map((file) => ({
        name: file.name,
        bytes: file.bytes?.byteLength ?? file.bytes?.length ?? 0,
        mimetype: file.mimetype ?? null,
      })),
    },
    limits: assignment.plugins,
    drafts,
    // Con drafts en 0, guardar entrega: por eso pide el nombre escrito igual
    // que el paso de entregar.
    requiresConfirmation: !drafts,
    requiresStatement: assignment.requiresStatement === 1,
    statement: assignment.requiresStatement === 1 ? STATEMENT_FALLBACK : null,
    current: assignment.submission
      ? {
          status: assignment.submission.status,
          canEdit: assignment.submission.canEdit === 1,
          submittedAt: iso(assignment.submission.submittedAt),
        }
      : null,
    blockers,
    warnings,
  };
}

// ── Escribir ───────────────────────────────────────────────────────────────

/** El estado real después de escribir. Nunca se deduce de lo que devolvió la escritura. */
async function refetchSubmission(userId, assignmentId, { fetchImpl, now }) {
  try {
    const payload = await callPva('mod_assign_get_submission_status', { assignid: assignmentId }, { fetchImpl });
    saveSubmissionStatus(userId, assignmentId, payload, { now });
    return null;
  } catch (err) {
    return `La escritura salió, pero no se pudo releer el estado: ${err.message}`;
  }
}

/**
 * Guarda la entrega. Con `submissiondrafts = 1` es un borrador que se puede
 * pisar; con 0 (lo que se vio en las 17 tareas) esto YA es la entrega, y por
 * eso pide el nombre de la tarea escrito.
 */
export async function saveSubmission(
  userId,
  assignmentId,
  { body = '', files = [], confirmName = null, dryRun = false, origin = 'web', fetchImpl, now = Date.now() } = {}
) {
  assertOrigin(origin);
  const preview = previewSubmission(userId, assignmentId, { body, files, now });
  if (!preview) throw new Error('Esa tarea no está en el aula sincronizada');

  const base = {
    userId,
    kind: preview.drafts ? 'borrador' : 'entrega',
    wsfunction: 'mod_assign_save_submission',
    courseId: preview.assignment.courseId,
    assignmentId,
    targetName: preview.assignment.name,
    preview: { sends: preview.sends, drafts: preview.drafts },
    dryRun,
    origin,
    now,
  };

  if (preview.blockers.length) {
    record({ ...base, status: 'rechazada', response: preview.blockers.join(' ') });
    const error = new Error(preview.blockers.join(' '));
    error.blockers = preview.blockers;
    throw error;
  }
  // El ensayo va ANTES de pedir el nombre: es lo que muestra qué viajaría, y
  // exigir la confirmación para ver el payload sería pedir que confirme a
  // ciegas justo lo que quiere mirar.
  if (dryRun) {
    const writeId = record({ ...base, status: 'ensayo', response: 'Ensayo: no se mandó nada.' });
    return { ...preview, writeId, sent: false, dryRun: true };
  }
  if (preview.requiresConfirmation && !sameName(confirmName, preview.assignment.name)) {
    const motivo = 'Esta tarea no tiene etapa de borrador: guardar es entregar. Escribí el nombre exacto de la tarea para confirmar.';
    record({ ...base, status: 'rechazada', response: motivo });
    throw new Error(motivo);
  }

  // Los dos plugins usan áreas de borrador distintas, así que cada uno pide su
  // itemid. Se piden acá y no antes: un itemid reservado en un ensayo sería
  // basura en el servidor.
  const plugindata = {};
  if (preview.sends.onlineText) {
    const itemId = await callPva('core_files_get_unused_draft_itemid', {}, { fetchImpl });
    plugindata.onlinetext_editor = {
      text: preview.sends.onlineText,
      format: 1,
      itemid: int(itemId?.itemid, 0),
    };
  }
  if (files.length) {
    const reserved = await callPva('core_files_get_unused_draft_itemid', {}, { fetchImpl });
    const itemId = int(reserved?.itemid, 0);
    for (const file of files) await uploadPva(file, { itemId, fetchImpl });
    plugindata.files_filemanager = itemId;
  }

  try {
    const response = await callPva('mod_assign_save_submission', { assignmentid: assignmentId, plugindata }, { fetchImpl });
    // Esta función contesta un arreglo de warnings: vacío es éxito. No se
    // interpreta más que eso, porque su forma no está verificada.
    const warnings = Array.isArray(response) ? response.map((entry) => text(entry.message ?? entry.item)) : [];
    const writeId = record({
      ...base,
      status: warnings.length ? 'error' : 'ok',
      response: warnings.length ? warnings.join(' ') : 'sin warnings',
    });
    const refetch = await refetchSubmission(userId, assignmentId, { fetchImpl, now });
    return {
      ...preview,
      writeId,
      sent: true,
      dryRun: false,
      warnings: [...preview.warnings, ...warnings, refetch].filter(Boolean),
    };
  } catch (err) {
    record({ ...base, status: 'error', errorcode: err.errorcode ?? null, response: err.message });
    throw err;
  }
}

/**
 * Entrega en firme. Solo existe cuando la tarea tiene etapa de borrador; en las
 * demás, `saveSubmission` ya entregó y llamar a esto sería mentirle a la
 * persona sobre lo que hace el botón.
 */
export async function submitForGrading(
  userId,
  assignmentId,
  { confirmName = null, acceptStatement = false, dryRun = false, origin = 'web', fetchImpl, now = Date.now() } = {}
) {
  assertOrigin(origin);
  const preview = previewSubmission(userId, assignmentId, { now, purpose: 'entregar' });
  if (!preview) throw new Error('Esa tarea no está en el aula sincronizada');

  const base = {
    userId,
    kind: 'entrega',
    wsfunction: 'mod_assign_submit_for_grading',
    courseId: preview.assignment.courseId,
    assignmentId,
    targetName: preview.assignment.name,
    preview: { confirmName: Boolean(confirmName), acceptStatement, requiresStatement: preview.requiresStatement },
    dryRun,
    origin,
    now,
  };

  const reject = (motivo) => {
    record({ ...base, status: 'rechazada', response: motivo });
    throw new Error(motivo);
  };

  if (!preview.drafts) {
    reject('Esta tarea no tiene etapa de borrador: lo que guardaste ya está entregado. No hay nada que enviar.');
  }
  if (preview.current?.status !== 'draft') {
    reject('No hay un borrador guardado que enviar.');
  }
  if (preview.blockers.length) reject(preview.blockers.join(' '));
  if (!sameName(confirmName, preview.assignment.name)) {
    reject('Escribí el nombre exacto de la tarea para entregar. Este paso no se deshace.');
  }
  // La declaración solo se manda cuando la tarea la exige: mandarla a ciegas es
  // aceptar en nombre de la persona algo que nadie le mostró (MAPA §3.9).
  if (preview.requiresStatement && acceptStatement !== true) {
    reject('Esta tarea exige aceptar la declaración de autoría y no fue aceptada.');
  }

  if (dryRun) {
    const writeId = record({ ...base, status: 'ensayo', response: 'Ensayo: no se mandó nada.' });
    return { ...preview, writeId, sent: false, dryRun: true };
  }

  const args = { assignmentid: assignmentId };
  if (preview.requiresStatement) args.acceptsubmissionstatement = true;
  try {
    const response = await callPva('mod_assign_submit_for_grading', args, { fetchImpl });
    const warnings = Array.isArray(response) ? response.map((entry) => text(entry.message ?? entry.item)) : [];
    const writeId = record({
      ...base,
      status: warnings.length ? 'error' : 'ok',
      response: warnings.length ? warnings.join(' ') : 'sin warnings',
    });
    const refetch = await refetchSubmission(userId, assignmentId, { fetchImpl, now });
    return { ...preview, writeId, sent: true, dryRun: false, warnings: [...warnings, refetch].filter(Boolean) };
  } catch (err) {
    record({ ...base, status: 'error', errorcode: err.errorcode ?? null, response: err.message });
    throw err;
  }
}

// ── Foros ──────────────────────────────────────────────────────────────────

/**
 * Las discusiones de un foro, leídas en el momento y no guardadas.
 *
 * Es el hueco central del dominio de avisos (MAPA §"foros"): mikampus solo
 * guarda el contador de anuncios, así que para responder hay que preguntar
 * ahora cuáles hay. Se lee bajo una acción de la persona, nunca en el sync, y
 * su forma no está verificada contra esta instancia: por eso se leen solo los
 * campos que hacen falta y lo que falte queda en null.
 */
export async function listDiscussions(userId, forumId, { fetchImpl, limit = 20 } = {}) {
  const forum = db
    .prepare('SELECT forum_id AS forumId, course_id AS courseId, cmid, name, type FROM pva_forum WHERE user_id = ? AND forum_id = ?')
    .get(userId, forumId);
  if (!forum) return null;

  const payload = await callPva(
    'mod_forum_get_forum_discussions',
    { forumid: forumId, sortorder: 1, page: 0, perpage: limit },
    { fetchImpl }
  );
  const rows = Array.isArray(payload?.discussions) ? payload.discussions : [];
  return {
    forum,
    discussions: rows.map((row) => ({
      discussionId: int(row.discussion ?? row.id, 0),
      // El post al que se responde es el primero de la discusión, y su id NO es
      // el de la discusión aunque casi siempre coincidan.
      postId: int(row.id ?? row.firstpost, 0),
      subject: text(row.subject ?? row.name),
      author: text(row.userfullname),
      locked: row.locked === true || row.locked === 1,
      canReply: row.canreply !== false,
      createdAt: iso(int(row.created, 0)),
      lastPostAt: iso(int(row.timemodified, 0)),
    })),
  };
}

/** Responde en una discusión. Un post publicado no se puede borrar desde acá. */
export async function replyToDiscussion(
  userId,
  { postId, discussionId = null, subject, message, forumName = null, dryRun = false, origin = 'web', fetchImpl, now = Date.now() } = {}
) {
  assertOrigin(origin);
  const cuerpo = String(message ?? '').trim();
  const titulo = String(subject ?? '').trim();
  const base = {
    userId,
    kind: 'foro',
    wsfunction: 'mod_forum_add_discussion_post',
    discussionId,
    targetName: forumName ?? `post ${postId}`,
    preview: { postId, subject: titulo, message: cuerpo },
    dryRun,
    origin,
    now,
  };

  if (!postId) {
    record({ ...base, status: 'rechazada', response: 'Falta a qué post responder.' });
    throw new Error('Falta a qué post responder.');
  }
  if (!cuerpo) {
    record({ ...base, status: 'rechazada', response: 'Una respuesta vacía no se publica.' });
    throw new Error('Una respuesta vacía no se publica.');
  }
  if (dryRun) {
    const writeId = record({ ...base, status: 'ensayo', response: 'Ensayo: no se mandó nada.' });
    return { writeId, sent: false, dryRun: true, sends: base.preview };
  }

  try {
    const response = await callPva(
      'mod_forum_add_discussion_post',
      {
        postid: postId,
        subject: titulo || 'Re:',
        message: cuerpo,
        options: [{ name: 'inlineattachmentsid', value: 0 }],
      },
      { fetchImpl }
    );
    const writeId = record({
      ...base,
      status: 'ok',
      response: response?.postid ? `postid ${response.postid}` : 'publicado',
    });
    return { writeId, sent: true, dryRun: false, sends: base.preview, postId: response?.postid ?? null };
  } catch (err) {
    record({ ...base, status: 'error', errorcode: err.errorcode ?? null, response: err.message });
    throw err;
  }
}
