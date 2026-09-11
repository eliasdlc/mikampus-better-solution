import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { db, logSync } from '../db.js';
import { readMeta, writeMeta } from '../appMeta.js';
import { dataPaths } from '../paths.js';
import { readPvaAccessKey, readPvaToken } from '../credentialStore.js';
import { MoodleError } from './client.js';
import { extractText } from './extract.js';
import { int, nowSeconds, text, textOrNull } from './shape.js';

// El espejo local de los materiales del aula.
//
// No hay una función de archivos en la PVA: hay cuatro fuentes con cuatro
// formas del mismo descriptor, y la descarga va por un endpoint HTTP que no es
// el servicio REST. Lo que este archivo resuelve, todo verificado en el recon:
//
//   1. La identidad de un archivo NO es su URL. En mod_resource la ruta lleva
//      un número de revisión que cambia cuando el profesor reemplaza el
//      fichero: con la URL como clave, cada reemplazo crearía una fila nueva.
//   2. El parámetro del token se llama `token`, no `wstoken`, y 33 de 87 URLs
//      no traen ninguna query: concatenar siempre con `&` rompe esas 33. Acá la
//      query se arma desde cero y el problema no existe.
//   3. Un `contents[]` con `type: 'url'` es un enlace a un tercero. Mandarle el
//      token sería filtrar la credencial a otro host, así que vive en otra
//      tabla y ninguna función de descarga lo mira.
//   4. Se puede recibir HTTP 200 con basura de tres formas distintas. Se valida
//      el Content-Type ANTES de escribir un byte a disco.
//   5. `timemodified` es la fecha de la restauración del curso (29 de 54
//      ficheros la comparten al minuto), así que no sirve de delta: la señal
//      fiable es el ETag, y por eso la descarga es un GET condicional.
//   6. No hay Content-Length: la respuesta va chunked. El tope por archivo se
//      aplica mientras se lee, no con un HEAD previo.

const MAX_FILE_MB_KEY = 'pva.files.maxFileMb';
const BUDGET_MB_KEY = 'pva.files.budgetMb';
// Un semestre son 100 a 250 MB, con la varianza dominada por uno o dos PDF
// gigantes: el tope por archivo deja fuera al de 45 MiB, que era el 61% de
// todos los bytes de la muestra, y lo deja anotado en vez de desaparecerlo.
export const DEFAULT_MAX_FILE_MB = 25;
export const DEFAULT_BUDGET_MB = 500;

export function fileLimits() {
  return {
    maxFileBytes: Number(readMeta(MAX_FILE_MB_KEY, DEFAULT_MAX_FILE_MB)) * 1024 * 1024,
    budgetBytes: Number(readMeta(BUDGET_MB_KEY, DEFAULT_BUDGET_MB)) * 1024 * 1024,
  };
}

export function setFileLimits({ maxFileMb, budgetMb } = {}) {
  if (maxFileMb != null) writeMeta(MAX_FILE_MB_KEY, Math.max(1, Math.floor(maxFileMb)));
  if (budgetMb != null) writeMeta(BUDGET_MB_KEY, Math.max(1, Math.floor(budgetMb)));
  return fileLimits();
}

// ── La URL ─────────────────────────────────────────────────────────────────

const PLUGINFILE = '/webservice/pluginfile.php/';

/**
 * Descompone una `fileurl` de pluginfile en sus partes.
 *
 * Hay dos plantillas y la diferencia no es el componente sino si el segmento
 * que sigue al área es un id: `mod_page/content/index.html` no trae itemid y
 * `mod_resource/content/1/apunte.pdf` sí. La regla que aguanta las dos es
 * "numérico Y con algo después"; un archivo llamado 12345 en la raíz no tiene
 * nada después, así que no se confunde con un itemid.
 *
 * El último segmento viene percent-encoded y el `filename` del JSON viene
 * decodificado: el nombre de disco sale del JSON, nunca de la URL.
 */
export function parsePluginfileUrl(fileurl) {
  const raw = String(fileurl ?? '');
  const index = raw.indexOf(PLUGINFILE);
  if (index < 0) return null;
  const [pathPart, query = ''] = raw.slice(index + PLUGINFILE.length).split('?');
  const segments = pathPart.split('/').filter(Boolean);
  if (segments.length < 4) return null;

  const [contextId, component, area, ...rest] = segments;
  const hasItemId = rest.length > 1 && /^\d+$/.test(rest[0]);
  const itemId = hasItemId ? Number(rest[0]) : null;
  const tail = hasItemId ? rest.slice(1) : rest;
  const filename = decodeURIComponent(tail.at(-1) ?? '');
  const filepath = tail.length > 1 ? `/${tail.slice(0, -1).map(decodeURIComponent).join('/')}/` : '/';

  return {
    base: raw.slice(0, index) + PLUGINFILE + pathPart.replace(/^\/+/, ''),
    contextId: Number(contextId),
    component,
    area,
    itemId,
    // En mod_resource ese número es una revisión: cambia al reemplazar el
    // fichero y por eso no puede ser parte de la identidad de la fila.
    revision: component === 'mod_resource' ? itemId : null,
    filepath,
    filename,
    forceDownload: /(^|&)forcedownload=1(&|$)/.test(query) ? 1 : 0,
  };
}

/**
 * La URL con la que se baja. Prefiere `tokenpluginfile.php`, que autentica con
 * la llave privada en la RUTA: así el token no queda en la query, que es lo
 * que termina en historiales y logs de proxy. Sin llave cae a `pluginfile.php`
 * con `token=`, que es el parámetro correcto (no `wstoken`).
 */
export function downloadUrlFor(file, { accessKey = null, token = null } = {}) {
  const query = file.force_download ? 'forcedownload=1' : '';
  if (accessKey) {
    const url = String(file.fileurl).replace(PLUGINFILE, `/tokenpluginfile.php/${accessKey}/`);
    return query ? `${url}?${query}` : url;
  }
  if (!token) throw new MoodleError('No hay con qué autenticar la descarga de la PVA', { kind: 'token' });
  return `${file.fileurl}?${query ? `${query}&` : ''}token=${encodeURIComponent(token)}`;
}

// ── Cosecha ────────────────────────────────────────────────────────────────

const upsertFile = () =>
  db.prepare(
    `INSERT INTO pva_file (
       user_id, course_id, cmid, context_id, component, area, item_id, revision, filepath, filename,
       fileurl, force_download, filesize, mimetype, isexternalfile, timecreated, timemodified,
       sortorder, license, source_fn, seen_at, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(course_id, cmid, component, area, filepath, filename) DO UPDATE SET
       context_id = excluded.context_id, item_id = excluded.item_id, revision = excluded.revision,
       fileurl = excluded.fileurl, force_download = excluded.force_download,
       filesize = excluded.filesize, mimetype = excluded.mimetype,
       isexternalfile = excluded.isexternalfile, timecreated = excluded.timecreated,
       timemodified = excluded.timemodified, sortorder = excluded.sortorder, license = excluded.license,
       source_fn = excluded.source_fn, seen_at = excluded.seen_at, deleted_at = NULL`
  );

function saveDescriptor(statement, userId, courseId, cmid, descriptor, sourceFn, stamp) {
  const parsed = parsePluginfileUrl(descriptor.fileurl);
  if (!parsed) return false;
  statement.run(
    userId,
    courseId,
    cmid,
    parsed.contextId,
    parsed.component,
    parsed.area,
    parsed.itemId,
    parsed.revision,
    parsed.filepath,
    // El nombre del JSON, no el de la URL: el de la URL viene escapado.
    text(descriptor.filename, parsed.filename),
    parsed.base,
    parsed.forceDownload,
    // Declarado: mod_page reporta 0 con cuerpo real, así que esto no es un
    // presupuesto de descarga.
    int(descriptor.filesize, 0),
    // La clave falta en 53 de 96 descriptores. Ausente y vacío no son lo mismo.
    textOrNull(descriptor.mimetype),
    descriptor.isexternalfile === undefined ? null : (descriptor.isexternalfile ? 1 : 0),
    int(descriptor.timecreated),
    int(descriptor.timemodified, 0),
    int(descriptor.sortorder),
    textOrNull(descriptor.license),
    sourceFn,
    stamp
  );
  return true;
}

/**
 * Registra los archivos y enlaces del árbol de un curso. No baja nada: solo
 * anota qué existe, para que la descarga pueda decidir con presupuesto.
 */
export function harvestCourseFiles(userId, courseId, sections, { now = Date.now() } = {}) {
  const stamp = nowSeconds(now);
  const statement = upsertFile();
  const upsertLink = db.prepare(
    `INSERT INTO pva_link (user_id, course_id, cmid, name, url, host, timemodified, seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cmid, url) DO UPDATE SET
       name = excluded.name, host = excluded.host, timemodified = excluded.timemodified,
       seen_at = excluded.seen_at`
  );
  const upsertInfo = db.prepare(
    `INSERT INTO pva_module_contents_info (cmid, files_count, files_size, last_modified, mime_types_json, repository_type, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(cmid) DO UPDATE SET
       files_count = excluded.files_count, files_size = excluded.files_size,
       last_modified = excluded.last_modified, mime_types_json = excluded.mime_types_json,
       repository_type = excluded.repository_type, updated_at = datetime('now')`
  );

  let files = 0;
  let links = 0;
  db.exec('BEGIN');
  try {
    for (const section of sections) {
      for (const module of section.modules ?? []) {
        const cmid = int(module.id, 0);
        for (const entry of module.contents ?? []) {
          if (entry.type === 'url') {
            // Un enlace externo no es un archivo: no tiene tamaño ni tipo, y
            // sobre todo no puede recibir el token.
            let host = '';
            try {
              host = new URL(entry.fileurl).host;
            } catch {
              host = '';
            }
            upsertLink.run(userId, courseId, cmid, text(entry.filename), text(entry.fileurl), host, int(entry.timemodified, 0), stamp);
            links += 1;
            continue;
          }
          if (saveDescriptor(statement, userId, courseId, cmid, entry, 'core_course_get_contents', stamp)) files += 1;
        }
        if (module.contentsinfo) {
          const info = module.contentsinfo;
          upsertInfo.run(
            cmid,
            int(info.filescount, 0),
            int(info.filessize, 0),
            int(info.lastmodified, 0),
            JSON.stringify(info.mimetypes ?? []),
            // La clave desaparece cuando el módulo no tiene ficheros: acceder
            // sin guardia es el bug clásico del dominio.
            Object.hasOwn(info, 'repositorytype') ? text(info.repositorytype) : null
          );
        }
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { files, links };
}

/** Los adjuntos del enunciado de cada tarea, que vienen con otra forma. */
export function harvestAssignmentFiles(userId, payload, { now = Date.now() } = {}) {
  const stamp = nowSeconds(now);
  const statement = upsertFile();
  let files = 0;
  db.exec('BEGIN');
  try {
    for (const course of payload.courses ?? []) {
      for (const assignment of course.assignments ?? []) {
        for (const attachment of assignment.introattachments ?? []) {
          if (saveDescriptor(statement, userId, int(assignment.course ?? course.id), int(assignment.cmid, 0), attachment, 'mod_assign_get_assignments', stamp)) {
            files += 1;
          }
        }
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { files };
}

// ── Descarga ───────────────────────────────────────────────────────────────

function blobPathFor(file, sha256) {
  const root = dataPaths().pvaFiles;
  return path.join(root, String(file.course_id), String(file.cmid), sha256.slice(0, 2), sha256);
}

/**
 * Baja un archivo si cambió. Devuelve qué pasó: `downloaded`, `unchanged`
 * (304), `skipped` (más grande que el tope) o lanza si el servidor contestó
 * algo que no es el archivo.
 */
export async function downloadFile(userId, file, { fetchImpl = globalThis.fetch, now = Date.now(), maxFileBytes = null } = {}) {
  const limits = fileLimits();
  const cap = maxFileBytes ?? limits.maxFileBytes;
  const blob = db.prepare('SELECT etag, last_modified AS lastModified, sha256, local_path AS localPath FROM pva_file_blob WHERE file_id = ?').get(file.file_id);
  const url = downloadUrlFor(file, { accessKey: readPvaAccessKey(), token: readPvaToken() });

  const headers = {};
  // El ETag es fuerte (sha1 del contenido) y es la única señal de cambio que
  // no miente en este dominio.
  if (blob?.etag) headers['If-None-Match'] = blob.etag;
  else if (blob?.lastModified) headers['If-Modified-Since'] = blob.lastModified;

  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(120_000) });
  const stamp = nowSeconds(now);

  if (response.status === 304) {
    db.prepare('UPDATE pva_file_blob SET verified_at = ?, last_error = NULL WHERE file_id = ?').run(stamp, file.file_id);
    await response.body?.cancel?.().catch(() => {});
    return { outcome: 'unchanged', bytes: 0 };
  }
  if (!response.ok) {
    throw new MoodleError(`La PVA respondió ${response.status} al bajar ${file.filename}`, {
      kind: response.status === 429 ? 'ratelimited' : response.status >= 500 ? 'server' : 'protocol',
      status: response.status,
    });
  }

  const contentType = response.headers.get('content-type') ?? '';
  // Un 200 con JSON es una excepción de Moodle disfrazada de archivo. Se
  // reconoce por el tipo y se lee para saber cuál.
  if (/application\/json/i.test(contentType)) {
    const body = await response.json().catch(() => null);
    throw new MoodleError(`La PVA no entregó el archivo: ${body?.errorcode ?? 'respuesta JSON'}`, {
      kind: body?.errorcode === 'invalidtoken' ? 'token' : 'protocol',
      errorcode: body?.errorcode ?? null,
    });
  }

  // Sin Content-Length no hay presupuesto previo: el tope se aplica leyendo.
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > cap) {
      await response.body?.cancel?.().catch(() => {});
      db.prepare(
        `INSERT INTO pva_file_blob (file_id, local_path, bytes, sha256, downloaded_at, verified_at, attempts, last_error)
         VALUES (?, '', 0, '', ?, ?, 1, ?)
         ON CONFLICT(file_id) DO UPDATE SET attempts = pva_file_blob.attempts + 1, last_error = excluded.last_error, verified_at = excluded.verified_at`
      ).run(file.file_id, stamp, stamp, `Más grande que el tope de ${Math.round(cap / 1024 / 1024)} MB`);
      return { outcome: 'skipped', bytes: 0, reason: 'demasiado grande' };
    }
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);

  // La otra forma de recibir 200 con basura es el HTML del login, después de un
  // 303. Pero HTML también es la respuesta LEGÍTIMA de una página de curso: su
  // index.html es el contenido de mayor valor por byte de todo el dominio, así
  // que rechazar todo el HTML rompería justo lo que más importa.
  //
  // La distinción sale del recon: el cuerpo de una página es un FRAGMENTO
  // (<div class="no-overflow">...), mientras que la pantalla de login es un
  // documento completo, y además llega tras una redirección.
  if (/text\/html/i.test(contentType)) {
    const head = buffer.subarray(0, 200).toString('utf8').trimStart().toLowerCase();
    if (response.redirected || head.startsWith('<!doctype html') || head.startsWith('<html')) {
      throw new MoodleError(`La PVA devolvió su pantalla de login en vez de ${file.filename}`, { kind: 'token' });
    }
  }

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const target = blobPathFor(file, sha256);

  // Mismo contenido con otra URL (el profesor subió el mismo archivo, o cambió
  // la revisión sin cambiar el fichero): no se reescribe el disco.
  const unchanged = blob?.sha256 === sha256 && fs.existsSync(target);
  if (!unchanged) {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, buffer, { mode: 0o600 });
    if (blob?.localPath && blob.localPath !== target && fs.existsSync(blob.localPath)) {
      // La versión anterior se va con la nueva: el espejo es del estado actual,
      // no un archivo de versiones.
      fs.rmSync(blob.localPath, { force: true });
    }
  }

  db.prepare(
    `INSERT INTO pva_file_blob (
       file_id, local_path, bytes, sha256, etag, last_modified, content_type, downloaded_at, verified_at, attempts, last_error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
     ON CONFLICT(file_id) DO UPDATE SET
       local_path = excluded.local_path, bytes = excluded.bytes, sha256 = excluded.sha256,
       etag = excluded.etag, last_modified = excluded.last_modified, content_type = excluded.content_type,
       downloaded_at = excluded.downloaded_at, verified_at = excluded.verified_at,
       attempts = 0, last_error = NULL`
  ).run(
    file.file_id,
    target,
    bytes,
    sha256,
    textOrNull(response.headers.get('etag')),
    textOrNull(response.headers.get('last-modified')),
    textOrNull(contentType),
    stamp,
    stamp
  );

  return { outcome: unchanged ? 'unchanged' : 'downloaded', bytes, sha256, buffer, contentType };
}

// ── Índice de texto ────────────────────────────────────────────────────────

export function indexFileText(file, buffer, { contentType = null, now = Date.now() } = {}) {
  return extractText(buffer, { contentType, mimetype: file.mimetype, filename: file.filename }).then((result) => {
    const stamp = nowSeconds(now);
    const previous = db.prepare('SELECT filename, content FROM pva_file_text WHERE file_id = ?').get(file.file_id);
    db.exec('BEGIN');
    try {
      // El índice es de contenido externo: hay que sacar la fila vieja con sus
      // valores antes de meter la nueva, o el índice queda con términos que ya
      // no existen.
      if (previous) {
        db.prepare("INSERT INTO pva_file_text_fts (pva_file_text_fts, rowid, filename, content) VALUES ('delete', ?, ?, ?)").run(
          file.file_id,
          previous.filename,
          previous.content
        );
      }
      db.prepare(
        `INSERT INTO pva_file_text (file_id, sha256, extractor, pages, filename, content, extracted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(file_id) DO UPDATE SET
           sha256 = excluded.sha256, extractor = excluded.extractor, pages = excluded.pages,
           filename = excluded.filename, content = excluded.content, extracted_at = excluded.extracted_at`
      ).run(file.file_id, file.sha256 ?? '', result.extractor, result.pages, file.filename, result.text, stamp);
      if (result.indexed) {
        db.prepare('INSERT INTO pva_file_text_fts (rowid, filename, content) VALUES (?, ?, ?)').run(
          file.file_id,
          file.filename,
          result.text
        );
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return result;
  });
}

// ── La corrida ─────────────────────────────────────────────────────────────

/**
 * Qué falta bajar, en el orden en que le sirve al estudiante: lo más reciente
 * primero, que es lo que se está estudiando ahora. Lo que ya se verificó hace
 * menos del tiempo de caché del servidor no se vuelve a pedir.
 */
export function filesToFetch(userId, { now = Date.now(), revalidateAfterS = 6 * 3600, limit = 200 } = {}) {
  return db
    .prepare(
      `SELECT f.file_id, f.course_id, f.cmid, f.filename, f.mimetype, f.fileurl, f.force_download, f.filesize,
              b.verified_at AS verifiedAt, b.sha256, b.bytes, b.last_error AS lastError
       FROM pva_file f
       LEFT JOIN pva_file_blob b ON b.file_id = f.file_id
       WHERE f.user_id = ? AND f.deleted_at IS NULL
         AND (b.file_id IS NULL OR b.verified_at < ?)
       ORDER BY b.file_id IS NOT NULL, f.timemodified DESC
       LIMIT ?`
    )
    .all(userId, nowSeconds(now) - revalidateAfterS, limit);
}

export function filesUsage(userId) {
  const row = db
    .prepare(
      `SELECT COUNT(1) AS files,
              SUM(CASE WHEN b.file_id IS NOT NULL AND b.bytes > 0 THEN 1 ELSE 0 END) AS downloaded,
              COALESCE(SUM(b.bytes), 0) AS bytes,
              SUM(CASE WHEN t.file_id IS NOT NULL AND t.content <> '' THEN 1 ELSE 0 END) AS indexed
       FROM pva_file f
       LEFT JOIN pva_file_blob b ON b.file_id = f.file_id
       LEFT JOIN pva_file_text t ON t.file_id = f.file_id
       WHERE f.user_id = ? AND f.deleted_at IS NULL`
    )
    .get(userId);
  const limits = fileLimits();
  return {
    files: row?.files ?? 0,
    downloaded: row?.downloaded ?? 0,
    bytes: row?.bytes ?? 0,
    indexed: row?.indexed ?? 0,
    budgetBytes: limits.budgetBytes,
    maxFileBytes: limits.maxFileBytes,
    remainingBytes: Math.max(0, limits.budgetBytes - (row?.bytes ?? 0)),
  };
}

/**
 * Baja lo que falta e indexa su texto, dentro del presupuesto. Un archivo que
 * falla no puede tumbar la corrida: se anota en su fila y sigue el siguiente.
 */
export async function syncFiles(userId, { fetchImpl = globalThis.fetch, now = Date.now(), limit = 50 } = {}) {
  const usage = filesUsage(userId);
  const summary = { downloaded: 0, unchanged: 0, skipped: 0, failed: 0, indexed: 0, bytes: 0, budgetLeft: usage.remainingBytes };

  for (const file of filesToFetch(userId, { now, limit })) {
    if (summary.budgetLeft <= 0) {
      summary.skipped += 1;
      continue;
    }
    try {
      const result = await downloadFile(userId, file, { fetchImpl, now });
      if (result.outcome === 'skipped') {
        summary.skipped += 1;
        continue;
      }
      if (result.outcome === 'unchanged') {
        // Dos caminos llegan acá: un 304, donde no hay cuerpo, y un 200 cuyo
        // contenido resultó idéntico al que ya estaba (el profesor reemplazó el
        // archivo por el mismo). En los dos el texto ya indexado sigue siendo
        // válido; solo se extrae si nunca se llegó a extraer.
        summary.unchanged += 1;
        const indexed = db.prepare('SELECT 1 FROM pva_file_text WHERE file_id = ?').get(file.file_id);
        if (result.buffer && !indexed) {
          const extracted = await indexFileText({ ...file, sha256: result.sha256 }, result.buffer, {
            contentType: result.contentType,
            now,
          });
          if (extracted.indexed) summary.indexed += 1;
        }
        continue;
      }
      summary.downloaded += 1;
      summary.bytes += result.bytes;
      summary.budgetLeft -= result.bytes;
      const extracted = await indexFileText(
        { ...file, sha256: result.sha256 },
        result.buffer,
        { contentType: result.contentType, now }
      );
      if (extracted.indexed) summary.indexed += 1;
    } catch (err) {
      summary.failed += 1;
      db.prepare(
        `INSERT INTO pva_file_blob (file_id, local_path, bytes, sha256, downloaded_at, verified_at, attempts, last_error)
         VALUES (?, '', 0, '', ?, ?, 1, ?)
         ON CONFLICT(file_id) DO UPDATE SET
           attempts = pva_file_blob.attempts + 1, last_error = excluded.last_error, verified_at = excluded.verified_at`
      ).run(file.file_id, nowSeconds(now), nowSeconds(now), err.message);
    }
  }

  logSync({
    userId,
    kind: 'pvaFiles',
    status: summary.failed && !summary.downloaded ? 'error' : 'ok',
    detail: `${summary.downloaded} bajado(s), ${summary.indexed} indexado(s), ${summary.unchanged} sin cambios`,
    rows: summary.downloaded,
  });
  return summary;
}

// ── Lectura ────────────────────────────────────────────────────────────────

export function searchFiles(userId, query, { limit = 20 } = {}) {
  return db
    .prepare(
      `SELECT f.file_id AS fileId, f.filename, f.course_id AS courseId, f.cmid, f.mimetype,
              t.extractor, t.pages,
              snippet(pva_file_text_fts, 1, '«', '»', '…', 12) AS snippet,
              bm25(pva_file_text_fts) AS score
       FROM pva_file_text_fts
       JOIN pva_file_text t ON t.file_id = pva_file_text_fts.rowid
       JOIN pva_file f ON f.file_id = t.file_id
       WHERE pva_file_text_fts MATCH ? AND f.user_id = ? AND f.deleted_at IS NULL
       ORDER BY score
       LIMIT ?`
    )
    .all(query, userId, limit);
}

export function courseLinks(userId, courseId) {
  return db
    .prepare(
      `SELECT link_id AS linkId, cmid, name, url, host FROM pva_link
       WHERE user_id = ? AND course_id = ? ORDER BY name`
    )
    .all(userId, courseId);
}
