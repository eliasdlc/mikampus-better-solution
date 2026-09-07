// Escribir en la PVA: lo único del proyecto que no se puede deshacer.
//
// Sin red. Lo que se verifica no es que el POST se arme bien (eso es lo fácil),
// sino que ninguna barrera se pueda saltar: que un ensayo no mande nada, que
// una tarea sin etapa de borrador no se entregue por accidente al "guardar",
// que la declaración de autoría no se acepte en nombre de nadie, y que toda
// intención quede asentada aunque haya sido rechazada.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-pva-write-'));
process.env.MIKAMPUS_DATA_DIR = dir;
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const { db } = await import('../src/db.js');
const { writeCredential, writePvaPassword, writePvaToken } = await import('../src/credentialStore.js');
const { saveCourses } = await import('../src/moodle/courses.js');
const { saveAssignments, saveSubmissionStatus } = await import('../src/moodle/assignments.js');
const writes = await import('../src/moodle/writes.js');

const USER = 1;
const NOW = 1_771_900_000_000;
const S = Math.floor(NOW / 1000);
const ASSIGN = 900001;

const fixture = async (name) => JSON.parse(await readFile(`fixtures/${name}`, 'utf8'));

// Un sitio de mentira que guarda cada llamada. `wsfunction` sale del cuerpo,
// igual que en el cliente real.
function site(handler = () => []) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = options?.body;
    const params = body instanceof URLSearchParams ? body : new URLSearchParams();
    const wsfunction = params.get('wsfunction') ?? (String(url).includes('upload.php') ? 'upload.php' : 'token.php');
    calls.push({ wsfunction, params });
    const data = handler(wsfunction, params);
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

const config = (assignmentId, rows) => {
  db.prepare('DELETE FROM pva_assignment_config WHERE assignment_id = ?').run(assignmentId);
  for (const [subtype, plugin, name, value] of rows) {
    db.prepare('INSERT INTO pva_assignment_config (assignment_id, subtype, plugin, name, value) VALUES (?, ?, ?, ?, ?)').run(
      assignmentId,
      subtype,
      plugin,
      name,
      value
    );
  }
};
const lastWrite = () => writes.recentWrites(USER, { limit: 1 })[0];
const rechazo = async (promise, patron, mensaje) => {
  await assert.rejects(promise, (error) => {
    assert.match(error.message, patron, mensaje);
    return true;
  });
  assert.equal(lastWrite().status, 'rechazada', 'y el rechazo queda asentado, no se pierde');
};

try {
  writeCredential({ username: '2021-0000', password: 'clave-portal' });
  writePvaPassword('clave-pva');
  writePvaToken('token-de-prueba');
  saveCourses(USER, await fixture('pva-courses.json'), { now: NOW });
  saveAssignments(USER, await fixture('pva-assignments.json'), { now: NOW });
  db.prepare('UPDATE pva_assignment SET duedate = ?, cutoffdate = NULL WHERE assignment_id = ?').run(S + 86_400, ASSIGN);
  // Como las 17 tareas del recon: sin etapa de borrador y sin declaración.
  db.prepare('UPDATE pva_assignment SET submissiondrafts = 0, requiresubmissionstatement = 0 WHERE assignment_id = ?').run(ASSIGN);
  config(ASSIGN, [
    ['assignsubmission', 'onlinetext', 'enabled', '1'],
    ['assignsubmission', 'onlinetext', 'wordlimit', '0'],
    ['assignsubmission', 'file', 'enabled', '1'],
    ['assignsubmission', 'file', 'maxfilesubmissions', '2'],
    ['assignsubmission', 'file', 'maxsubmissionsizebytes', '1000'],
    ['assignsubmission', 'file', 'filetypeslist', '.pdf,.docx'],
  ]);
  const NOMBRE = writes.assignmentForWrite(USER, ASSIGN).name;

  // ── La vista previa es el payload, no un resumen ──
  {
    const preview = writes.previewSubmission(USER, ASSIGN, { body: '  Mi respuesta  ', now: NOW });
    assert.equal(preview.sends.onlineText, 'Mi respuesta', 'exactamente el texto que va a viajar');
    assert.deepEqual(preview.blockers, []);
    assert.equal(preview.drafts, false);
    assert.equal(preview.requiresConfirmation, true, 'sin etapa de borrador, guardar es entregar');
    assert.equal(preview.requiresStatement, false);
    assert.equal(writes.previewSubmission(USER, 404_404, { now: NOW }), null, 'una tarea que no existe es null');
  }

  // ── Un ensayo no toca el servidor, y aun así queda asentado ──
  {
    const { calls, fetchImpl } = site();
    const result = await writes.saveSubmission(USER, ASSIGN, {
      body: 'Mi respuesta',
      confirmName: NOMBRE,
      dryRun: true,
      origin: 'web',
      fetchImpl,
      now: NOW,
    });
    assert.equal(calls.length, 0, 'un ensayo no manda NADA');
    assert.equal(result.sent, false);
    const fila = lastWrite();
    assert.equal(fila.status, 'ensayo');
    assert.equal(fila.dryRun, true);
    assert.equal(fila.preview.sends.onlineText, 'Mi respuesta', 'y guarda qué se habría mandado');
  }

  // ── Las barreras ──
  {
    const { calls, fetchImpl } = site();
    // Sin etapa de borrador, guardar entrega: exige el nombre escrito.
    await rechazo(
      writes.saveSubmission(USER, ASSIGN, { body: 'x', fetchImpl, now: NOW }),
      /nombre exacto de la tarea/,
      'guardar sin confirmar en una tarea sin borrador'
    );
    await rechazo(
      writes.saveSubmission(USER, ASSIGN, { body: 'x', confirmName: 'otra cosa', fetchImpl, now: NOW }),
      /nombre exacto/,
      'y un nombre que no es el de la tarea no confirma nada'
    );
    // El acento y la caja no son la barrera; el nombre sí.
    assert.ok(
      (await writes.saveSubmission(USER, ASSIGN, {
        body: 'x',
        confirmName: NOMBRE.toUpperCase(),
        dryRun: true,
        fetchImpl,
        now: NOW,
      })).writeId
    );

    await rechazo(
      writes.saveSubmission(USER, ASSIGN, { confirmName: NOMBRE, fetchImpl, now: NOW }),
      /No hay nada que mandar/,
      'una entrega vacía no se manda'
    );
    await rechazo(
      writes.saveSubmission(USER, ASSIGN, {
        confirmName: NOMBRE,
        files: [{ name: 'grande.pdf', bytes: new Uint8Array(2000) }],
        fetchImpl,
        now: NOW,
      }),
      /máximo por archivo/,
      'el tope de tamaño se mira antes de subir'
    );
    await rechazo(
      writes.saveSubmission(USER, ASSIGN, {
        confirmName: NOMBRE,
        files: [{ name: 'notas.txt', bytes: new Uint8Array(10) }],
        fetchImpl,
        now: NOW,
      }),
      /extensiones permitidas/,
      'y la lista de extensiones también'
    );
    await rechazo(
      writes.saveSubmission(USER, ASSIGN, {
        confirmName: NOMBRE,
        files: [1, 2, 3].map((n) => ({ name: `${n}.pdf`, bytes: new Uint8Array(10) })),
        fetchImpl,
        now: NOW,
      }),
      /Acepta 2 archivo/,
      'tres archivos donde caben dos'
    );
    assert.equal(calls.length, 0, 'ninguna barrera llegó a tocar el servidor');

    // El cierre duro no es la fecha de entrega: pasada la primera se entrega
    // tarde, pasada la segunda no se entrega.
    db.prepare('UPDATE pva_assignment SET cutoffdate = ? WHERE assignment_id = ?').run(S - 3600, ASSIGN);
    await rechazo(
      writes.saveSubmission(USER, ASSIGN, { body: 'x', confirmName: NOMBRE, fetchImpl, now: NOW }),
      /cierre duro/,
      'después del cierre duro la plataforma no acepta nada'
    );
    db.prepare('UPDATE pva_assignment SET cutoffdate = NULL, duedate = ? WHERE assignment_id = ?').run(S - 3600, ASSIGN);
    const tarde = writes.previewSubmission(USER, ASSIGN, { body: 'x', now: NOW });
    assert.deepEqual(tarde.blockers, [], 'una entrega tarde es legítima');
    assert.match(tarde.warnings.join(' '), /tarde/, 'pero se avisa');
    db.prepare('UPDATE pva_assignment SET duedate = ? WHERE assignment_id = ?').run(S + 86_400, ASSIGN);

    // Un origen que no nace de una acción de la persona no existe.
    await assert.rejects(
      writes.saveSubmission(USER, ASSIGN, { body: 'x', confirmName: NOMBRE, origin: 'auto', fetchImpl, now: NOW }),
      /Origen de escritura inválido/
    );
  }

  // ── La entrega que sí sale ──
  {
    const { calls, fetchImpl } = site((wsfunction) => {
      if (wsfunction === 'core_files_get_unused_draft_itemid') return { itemid: 777 };
      if (wsfunction === 'mod_assign_get_submission_status') return null;
      return [];
    });
    const result = await writes.saveSubmission(USER, ASSIGN, {
      body: 'Mi respuesta final',
      confirmName: NOMBRE,
      origin: 'web',
      fetchImpl,
      now: NOW,
    });
    assert.equal(result.sent, true);
    const guardar = calls.find((call) => call.wsfunction === 'mod_assign_save_submission');
    assert.equal(guardar.params.get('assignmentid'), String(ASSIGN));
    assert.equal(
      guardar.params.get('plugindata[onlinetext_editor][text]'),
      'Mi respuesta final',
      'el texto viaja aplanado al estilo de Moodle o llega vacío'
    );
    assert.equal(guardar.params.get('plugindata[onlinetext_editor][itemid]'), '777', 'con el itemid de borrador reservado');
    assert.ok(
      calls.some((call) => call.wsfunction === 'mod_assign_get_submission_status'),
      'y después se relee el estado real: la respuesta de la escritura no se interpreta'
    );
    assert.equal(lastWrite().status, 'ok');
    assert.equal(lastWrite().kind, 'entrega', 'sin etapa de borrador, guardar quedó asentado como entrega');
  }

  // ── Un error del servidor queda con su código ──
  {
    const { fetchImpl } = site((wsfunction) => {
      if (wsfunction === 'core_files_get_unused_draft_itemid') return { itemid: 1 };
      if (wsfunction === 'mod_assign_save_submission') {
        return { exception: 'moodle_exception', errorcode: 'nopermissions', message: 'Sin permiso' };
      }
      return [];
    });
    await assert.rejects(
      writes.saveSubmission(USER, ASSIGN, { body: 'x', confirmName: NOMBRE, fetchImpl, now: NOW }),
      /nopermissions/
    );
    const fila = lastWrite();
    assert.equal(fila.status, 'error');
    assert.equal(fila.errorcode, 'nopermissions', 'con el código, que es lo que decide qué hacer después');
  }

  // ── Entregar en firme solo existe donde hay borrador ──
  {
    const { calls, fetchImpl } = site();
    await rechazo(
      writes.submitForGrading(USER, ASSIGN, { confirmName: NOMBRE, fetchImpl, now: NOW }),
      /no tiene etapa de borrador/,
      'con submissiondrafts en 0, "entregar" mentiría sobre lo que hace'
    );

    db.prepare('UPDATE pva_assignment SET submissiondrafts = 1 WHERE assignment_id = ?').run(ASSIGN);
    await rechazo(
      writes.submitForGrading(USER, ASSIGN, { confirmName: NOMBRE, fetchImpl, now: NOW }),
      /No hay un borrador guardado/,
      'no se envía lo que no se guardó'
    );

    const status = await fixture('pva-submission-graded.json');
    status.lastattempt.submission.status = 'draft';
    status.lastattempt.gradingstatus = 'notgraded';
    status.lastattempt.canedit = true;
    saveSubmissionStatus(USER, ASSIGN, status, { now: NOW });

    await rechazo(
      writes.submitForGrading(USER, ASSIGN, { confirmName: 'no es', fetchImpl, now: NOW }),
      /nombre exacto/,
      'entregar pide el nombre escrito'
    );

    // Con declaración exigida, no aceptarla es un rechazo; aceptarla es lo
    // único que la manda.
    db.prepare('UPDATE pva_assignment SET requiresubmissionstatement = 1 WHERE assignment_id = ?').run(ASSIGN);
    await rechazo(
      writes.submitForGrading(USER, ASSIGN, { confirmName: NOMBRE, fetchImpl, now: NOW }),
      /declaración de autoría/,
      'la declaración no se acepta en nombre de nadie'
    );
    assert.equal(calls.length, 0);

    await writes.submitForGrading(USER, ASSIGN, { confirmName: NOMBRE, acceptStatement: true, fetchImpl, now: NOW });
    const enviar = calls.find((call) => call.wsfunction === 'mod_assign_submit_for_grading');
    assert.equal(enviar.params.get('acceptsubmissionstatement'), '1');

    db.prepare('UPDATE pva_assignment SET requiresubmissionstatement = 0 WHERE assignment_id = ?').run(ASSIGN);
    const limpio = site();
    await writes.submitForGrading(USER, ASSIGN, { confirmName: NOMBRE, fetchImpl: limpio.fetchImpl, now: NOW });
    const sinDeclaracion = limpio.calls.find((call) => call.wsfunction === 'mod_assign_submit_for_grading');
    assert.equal(
      sinDeclaracion.params.get('acceptsubmissionstatement'),
      null,
      'y donde no se exige, el parámetro no viaja: aceptar a ciegas es firmar por otro'
    );
  }

  // ── Foros ──
  {
    const { calls, fetchImpl } = site(() => ({ postid: 555 }));
    await rechazo(
      writes.replyToDiscussion(USER, { postId: 1, message: '   ', fetchImpl, now: NOW }),
      /respuesta vacía/,
      'una respuesta vacía no se publica'
    );
    const ensayo = await writes.replyToDiscussion(USER, { postId: 1, message: 'Hola', dryRun: true, fetchImpl, now: NOW });
    assert.equal(ensayo.sent, false);
    assert.equal(calls.length, 0);

    const publicado = await writes.replyToDiscussion(USER, {
      postId: 1,
      discussionId: 9,
      subject: 'Re: duda',
      message: 'Mi respuesta',
      fetchImpl,
      now: NOW,
    });
    assert.equal(publicado.postId, 555);
    assert.equal(calls.at(-1).params.get('postid'), '1');
    assert.equal(lastWrite().status, 'ok');
    assert.equal(lastWrite().kind, 'foro');
  }

  // ── El token no entra al libro de escrituras ──
  {
    const filas = writes.recentWrites(USER, { limit: 100 });
    assert.ok(filas.length > 10, 'toda intención quedó asentada, incluidas las rechazadas');
    assert.ok(
      !JSON.stringify(filas).includes('token-de-prueba'),
      'el token es una contraseña: no aparece en el libro ni en un backup'
    );
  }

  // ── Ninguna escritura automática, verificado sobre los imports ──
  {
    const STATIC_IMPORT = /^\s*import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/gm;
    const graph = async (entry) => {
      const seen = new Set();
      const pending = [entry];
      while (pending.length > 0) {
        const file = pending.pop();
        if (seen.has(file)) continue;
        seen.add(file);
        let source;
        try {
          source = await readFile(file, 'utf8');
        } catch {
          continue;
        }
        for (const match of source.matchAll(STATIC_IMPORT)) {
          if (!match[1].startsWith('.')) continue;
          pending.push(path.resolve(path.dirname(file), match[1]));
        }
      }
      return [...seen].map((file) => path.relative(root, file));
    };
    for (const entry of ['src/syncOrchestrator.js', 'src/scheduler.js', 'src/cron.js']) {
      const alcanza = await graph(path.join(root, entry));
      assert.ok(
        !alcanza.includes('src/moodle/writes.js'),
        `${entry} no puede alcanzar el módulo de escritura: una escritura automática no existe`
      );
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ escritura en la PVA: el ensayo no manda nada, guardar sin borrador exige confirmar, la declaración no se firma por nadie y el sync no alcanza este módulo');
