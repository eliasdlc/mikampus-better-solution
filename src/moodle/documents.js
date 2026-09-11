import fs from 'node:fs';
import { db } from '../db.js';
import { downloadFile, indexFileText, filesUsage } from './files.js';
import { nowSeconds } from './shape.js';

// El material de una materia, junto y buscable.
//
// La PVA reparte los archivos entre las unidades del profesor, así que para
// encontrar un PDF hay que acordarse de en qué unidad lo puso. Acá la misma
// lista se ve entera, con la unidad como dato y no como carpeta obligatoria.
//
// Tres cosas que este módulo no inventa:
//
//   1. `pva_file.filesize` es el tamaño DECLARADO por la plataforma, y un
//      mod_page declara 0 con cuerpo real. Cuando el archivo está bajado se
//      muestran los bytes reales; cuando no, el declarado, y se dice cuál es.
//   2. Bajado no es lo mismo que buscable: un PDF escaneado se baja completo y
//      no deja texto. Son dos estados distintos y la pantalla los separa.
//   3. Una fila de blob puede existir con 0 bytes: es el registro de un intento
//      fallido, no un archivo. Solo cuenta como bajado lo que tiene ruta y peso.

// El corte entre liviano y pesado. Sale de la medición del recon: la mediana es
// 103 KB y un solo PDF de 45 MB es el 61% de todos los bytes de la materia. Con
// este corte, "bajar lo que falta" nunca arrastra ese archivo sin decirlo.
export const HEAVY_BYTES = 10 * 1024 * 1024;

const SELECT_DOC = `
  SELECT f.file_id AS fileId, f.filename, f.mimetype, f.filesize AS declaredBytes,
         f.course_id AS courseId, f.cmid, f.component, f.area, f.fileurl, f.force_download AS forceDownload,
         f.timemodified AS modifiedAt,
         b.bytes AS realBytes, b.content_type AS contentType, b.local_path AS localPath,
         b.last_error AS lastError,
         t.file_id AS textId, t.pages, t.extractor,
         m.name AS moduleName, m.modname, m.url AS moduleUrl, m.sort_index AS moduleIndex,
         s.name AS sectionName, s.sort_index AS sectionIndex
  FROM pva_file f
  LEFT JOIN pva_file_blob b ON b.file_id = f.file_id
  LEFT JOIN pva_file_text t ON t.file_id = f.file_id
  LEFT JOIN pva_module m ON m.cmid = f.cmid
  LEFT JOIN pva_course_section s ON s.section_id = m.section_id
`;

/** Un archivo tal como lo lee la pantalla: con su unidad, su peso y su estado. */
function shape(row) {
  const downloaded = Boolean(row.localPath) && row.realBytes > 0;
  return {
    fileId: row.fileId,
    courseId: row.courseId,
    filename: row.filename,
    mimetype: row.contentType ?? row.mimetype ?? null,
    // El peso real manda sobre el declarado, y se dice cuál de los dos es.
    bytes: downloaded ? row.realBytes : row.declaredBytes,
    bytesAreDeclared: !downloaded,
    downloaded,
    indexed: row.textId != null,
    pages: row.pages ?? null,
    extractor: row.extractor ?? null,
    lastError: row.lastError ?? null,
    cmid: row.cmid,
    moduleName: row.moduleName ?? null,
    modname: row.modname ?? null,
    moduleUrl: row.moduleUrl ?? null,
    sectionName: row.sectionName ?? null,
    // De dónde salió: el enunciado de una tarea y el material de una unidad se
    // ven distinto aunque los dos sean PDF.
    origin: row.component === 'mod_assign' ? 'tarea' : row.component === 'assignfeedback_editpdf' ? 'corrección' : 'material',
  };
}

/** Todo el material de una materia, en el orden del curso. */
export function courseDocuments(userId, courseId) {
  return db
    .prepare(
      `${SELECT_DOC}
       WHERE f.user_id = ? AND f.course_id = ? AND f.deleted_at IS NULL
       ORDER BY COALESCE(s.sort_index, 9999), COALESCE(m.sort_index, 9999), f.filename`
    )
    .all(userId, courseId)
    .map(shape);
}

/** Un archivo con lo que hace falta para servirlo. Null si no es de esta persona. */
export function documentFor(userId, fileId) {
  const row = db.prepare(`${SELECT_DOC} WHERE f.user_id = ? AND f.file_id = ? AND f.deleted_at IS NULL`).get(userId, fileId);
  if (!row) return null;
  return { ...shape(row), localPath: row.localPath || null };
}

/** El texto extraído de un archivo, para buscar dentro sin volver a abrirlo. */
export function documentText(userId, fileId) {
  const row = db
    .prepare(
      `SELECT t.content, t.pages, t.extractor, f.filename
       FROM pva_file_text t JOIN pva_file f ON f.file_id = t.file_id
       WHERE f.user_id = ? AND t.file_id = ?`
    )
    .get(userId, fileId);
  return row ?? null;
}

/**
 * Busca dentro del material de UNA materia.
 *
 * `searchFiles` busca en todo lo que hay; esta acota al curso, que es la
 * pregunta que se hace desde adentro de una materia.
 */
export function searchCourseDocuments(userId, courseId, query, { limit = 20 } = {}) {
  const term = String(query ?? '').trim();
  if (!term) return [];
  return db
    .prepare(
      `SELECT f.file_id AS fileId, f.filename, f.cmid, m.name AS moduleName, s.name AS sectionName,
              t.pages, t.extractor,
              snippet(pva_file_text_fts, 1, '«', '»', '…', 14) AS snippet,
              bm25(pva_file_text_fts) AS score
       FROM pva_file_text_fts
       JOIN pva_file_text t ON t.file_id = pva_file_text_fts.rowid
       JOIN pva_file f ON f.file_id = t.file_id
       LEFT JOIN pva_module m ON m.cmid = f.cmid
       LEFT JOIN pva_course_section s ON s.section_id = m.section_id
       WHERE pva_file_text_fts MATCH ? AND f.user_id = ? AND f.course_id = ? AND f.deleted_at IS NULL
       ORDER BY score
       LIMIT ?`
    )
    .all(term, userId, courseId, limit);
}

/**
 * Qué falta bajar de una materia, separado por peso.
 *
 * El número va ANTES del botón: "bajar todo" sin el peso adelante es cómo un
 * PDF de 45 MB se cuela en una conexión de datos.
 */
export function pendingDownloads(userId, courseId, { heavyBytes = HEAVY_BYTES } = {}) {
  const rows = db
    .prepare(
      `SELECT f.file_id AS fileId, f.filesize AS declaredBytes
       FROM pva_file f LEFT JOIN pva_file_blob b ON b.file_id = f.file_id
       WHERE f.user_id = ? AND f.course_id = ? AND f.deleted_at IS NULL
         AND (b.file_id IS NULL OR b.local_path = '' OR b.bytes = 0)`
    )
    .all(userId, courseId);
  const bucket = (heavy) => {
    const list = rows.filter((row) => (row.declaredBytes >= heavyBytes) === heavy);
    return { files: list.length, bytes: list.reduce((total, row) => total + row.declaredBytes, 0) };
  };
  return { light: bucket(false), heavy: bucket(true), heavyBytes };
}

/**
 * Baja lo que falta de una materia, por pedido de la persona.
 *
 * No es el sync: no revalida lo que ya está ni corre solo. Solo trae lo que
 * falta, y lo pesado únicamente si se pidió explícitamente.
 */
export async function downloadCourseDocuments(
  userId,
  courseId,
  { includeHeavy = false, heavyBytes = HEAVY_BYTES, fetchImpl = globalThis.fetch, now = Date.now(), limit = 100 } = {}
) {
  const pending = db
    .prepare(
      `SELECT f.file_id, f.course_id, f.cmid, f.filename, f.mimetype, f.fileurl, f.force_download, f.filesize
       FROM pva_file f LEFT JOIN pva_file_blob b ON b.file_id = f.file_id
       WHERE f.user_id = ? AND f.course_id = ? AND f.deleted_at IS NULL
         AND (b.file_id IS NULL OR b.local_path = '' OR b.bytes = 0)
       ORDER BY f.filesize
       LIMIT ?`
    )
    .all(userId, courseId, limit)
    .filter((file) => includeHeavy || file.filesize < heavyBytes);

  const summary = { downloaded: 0, indexed: 0, failed: 0, skipped: 0, bytes: 0, budgetLeft: filesUsage(userId).remainingBytes };
  for (const file of pending) {
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
      if (result.buffer) {
        const extracted = await indexFileText({ ...file, sha256: result.sha256 }, result.buffer, {
          contentType: result.contentType,
          now,
        });
        if (extracted.indexed) summary.indexed += 1;
      }
      if (result.outcome === 'downloaded') {
        summary.downloaded += 1;
        summary.bytes += result.bytes;
        summary.budgetLeft -= result.bytes;
      }
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
  return summary;
}

/** El archivo en disco, si de verdad está. Devuelve null en vez de romper. */
export function blobOf(userId, fileId) {
  const row = db
    .prepare(
      `SELECT b.local_path AS localPath, b.bytes, b.content_type AS contentType, f.filename, f.mimetype
       FROM pva_file_blob b JOIN pva_file f ON f.file_id = b.file_id
       WHERE f.user_id = ? AND b.file_id = ? AND f.deleted_at IS NULL`
    )
    .get(userId, fileId);
  if (!row?.localPath || row.bytes <= 0) return null;
  if (!fs.existsSync(row.localPath)) return null;
  return {
    path: row.localPath,
    bytes: row.bytes,
    filename: row.filename,
    // El tipo real del blob manda sobre el declarado por la plataforma.
    contentType: row.contentType || row.mimetype || 'application/octet-stream',
  };
}
