// El material de una materia: lo que la pantalla Material recibe.
//
// Sin red. Lo que se verifica es lo que separa "tengo los archivos" de "puedo
// usarlos": que bajado y buscable sean dos estados distintos, que un intento
// fallido no se cuente como archivo, que el peso declarado no se haga pasar por
// real, y que "bajar lo que falta" nunca arrastre el archivo gigante sin decirlo.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-material-'));
process.env.MIKAMPUS_DATA_DIR = dir;
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');

const { db } = await import('../src/db.js');
const { saveCourses, saveCourseContents } = await import('../src/moodle/courses.js');
const { harvestCourseFiles } = await import('../src/moodle/files.js');
const {
  courseDocuments,
  searchCourseDocuments,
  pendingDownloads,
  documentText,
  blobOf,
  HEAVY_BYTES,
} = await import('../src/moodle/documents.js');

const USER = 1;
const COURSE = 800101;
const NOW = 1_771_900_000_000;
const S = Math.floor(NOW / 1000);
const SITE = 'https://campusvirtual.pucmm.edu.do/moodle';

// Un curso con dos unidades y cuatro archivos, como los reparte la PVA.
const archivo = (cmid, filename, filesize, mimetype) => ({
  type: 'file',
  filename,
  filepath: '/',
  filesize,
  fileurl: `${SITE}/webservice/pluginfile.php/${99000 + cmid}/mod_resource/content/1/${filename}`,
  timemodified: S - 86_400,
  mimetype,
});
const modulo = (cmid, name, contents) => ({
  id: cmid,
  instance: cmid,
  name,
  modname: 'resource',
  url: `${SITE}/mod/resource/view.php?id=${cmid}`,
  visible: 1,
  uservisible: true,
  noviewlink: false,
  completion: 0,
  customdata: '""',
  dates: [],
  contents,
});

const SECTIONS = [
  {
    id: 7001,
    name: 'Unidad 1: Complejidad',
    section: 0,
    visible: 1,
    uservisible: true,
    summary: '',
    summaryformat: 1,
    modules: [
      modulo(910001, 'Guía de laboratorio', [archivo(910001, 'guia-03.pdf', 412_000, 'application/pdf')]),
      modulo(910002, 'Libro del curso', [archivo(910002, 'libro.pdf', 45 * 1024 * 1024, 'application/pdf')]),
    ],
  },
  {
    id: 7002,
    name: 'Unidad 2: Árboles',
    section: 1,
    visible: 1,
    uservisible: true,
    summary: '',
    summaryformat: 1,
    modules: [
      modulo(910003, 'Diagrama', [archivo(910003, 'avl.png', 1_200_000, 'image/png')]),
      // mod_page declara 0 bytes con cuerpo real: el caso que hace que el peso
      // declarado no se pueda mostrar como si fuera el de verdad.
      modulo(910004, 'Notas de clase', [archivo(910004, 'index.html', 0, null)]),
    ],
  },
];

try {
  saveCourses(
    USER,
    [{ id: COURSE, shortname: 'ICC-311-01', fullname: 'Estructuras de datos', visible: 1, hidden: false, timemodified: S }],
    { now: NOW }
  );
  saveCourseContents(USER, COURSE, SECTIONS, { now: NOW });
  const cosecha = harvestCourseFiles(USER, COURSE, SECTIONS, { now: NOW });
  assert.equal(cosecha.files, 4);

  const idDe = (filename) => db.prepare('SELECT file_id AS id FROM pva_file WHERE filename = ?').get(filename).id;

  // ── Antes de bajar nada: todo falta, y el peso es el declarado ──
  {
    const docs = courseDocuments(USER, COURSE);
    assert.equal(docs.length, 4);
    assert.deepEqual(
      docs.map((doc) => doc.filename),
      ['guia-03.pdf', 'libro.pdf', 'avl.png', 'index.html'],
      'en el orden del curso: unidad, módulo, nombre'
    );
    assert.equal(docs[0].sectionName, 'Unidad 1: Complejidad', 'cada archivo sabe de qué unidad salió');
    assert.ok(docs.every((doc) => !doc.downloaded && !doc.indexed));
    assert.equal(docs[0].bytesAreDeclared, true, 'sin bajar, el peso es el que declaró la plataforma');
    assert.equal(docs[3].bytes, 0, 'y un mod_page declara 0 aunque tenga cuerpo');
  }

  // ── Lo que falta, separado por peso ──
  {
    const pendiente = pendingDownloads(USER, COURSE);
    assert.equal(pendiente.heavyBytes, HEAVY_BYTES);
    assert.deepEqual(
      { archivos: pendiente.light.files, bytes: pendiente.light.bytes },
      { archivos: 3, bytes: 412_000 + 1_200_000 },
      'los livianos van juntos con su peso sumado'
    );
    assert.deepEqual(
      { archivos: pendiente.heavy.files, bytes: pendiente.heavy.bytes },
      { archivos: 1, bytes: 45 * 1024 * 1024 },
      'y el de 45 MB queda aparte: él solo pesa más que toda la materia'
    );
  }

  // ── Bajado no es lo mismo que buscable ──
  {
    const guia = idDe('guia-03.pdf');
    const png = idDe('avl.png');
    const rutaGuia = path.join(dir, 'guia.bin');
    await writeFile(rutaGuia, 'contenido');
    db.prepare(
      `INSERT INTO pva_file_blob (file_id, local_path, bytes, sha256, content_type, downloaded_at, verified_at)
       VALUES (?, ?, 400123, 'aa', 'application/pdf', ?, ?)`
    ).run(guia, rutaGuia, S, S);
    db.prepare(
      `INSERT INTO pva_file_text (file_id, sha256, extractor, pages, filename, content, extracted_at)
       VALUES (?, 'aa', 'pdf', 12, 'guia-03.pdf', 'la rotación de un árbol AVL mantiene el balance', ?)`
    ).run(guia, S);
    db.prepare('INSERT INTO pva_file_text_fts (rowid, filename, content) VALUES (?, ?, ?)').run(
      guia,
      'guia-03.pdf',
      'la rotación de un árbol AVL mantiene el balance'
    );
    // El PNG se bajó y no dejó texto: se puede abrir, no se puede buscar.
    db.prepare(
      `INSERT INTO pva_file_blob (file_id, local_path, bytes, sha256, content_type, downloaded_at, verified_at)
       VALUES (?, ?, 1200000, 'bb', 'image/png', ?, ?)`
    ).run(png, path.join(dir, 'no-existe.png'), S, S);

    const docs = courseDocuments(USER, COURSE);
    const porNombre = new Map(docs.map((doc) => [doc.filename, doc]));
    assert.deepEqual(
      { bajado: porNombre.get('guia-03.pdf').downloaded, buscable: porNombre.get('guia-03.pdf').indexed },
      { bajado: true, buscable: true }
    );
    assert.deepEqual(
      { bajado: porNombre.get('avl.png').downloaded, buscable: porNombre.get('avl.png').indexed },
      { bajado: true, buscable: false },
      'un archivo bajado sin texto extraído no es buscable, y son dos estados distintos'
    );
    assert.equal(porNombre.get('guia-03.pdf').bytes, 400123, 'bajado, manda el peso real');
    assert.equal(porNombre.get('guia-03.pdf').bytesAreDeclared, false);

    // El blob se sirve solo si de verdad está en disco.
    assert.ok(blobOf(USER, guia), 'la guía está en disco y se puede servir');
    assert.equal(blobOf(USER, png), null, 'el PNG tiene fila pero no archivo: se dice que no en vez de romper');
    assert.equal(blobOf(USER + 1, guia), null, 'y el archivo de otra persona no existe para esta');

    assert.match(documentText(USER, guia).content, /AVL/);
    assert.equal(documentText(USER, idDe('libro.pdf')), null, 'sin texto extraído devuelve null, no una cadena vacía');
  }

  // ── Buscar adentro de la materia ──
  {
    const hits = searchCourseDocuments(USER, COURSE, 'rotacion');
    assert.equal(hits.length, 1, 'la búsqueda ignora los acentos, como el tokenizer del índice');
    assert.equal(hits[0].filename, 'guia-03.pdf');
    assert.match(hits[0].snippet, /«/, 'y el fragmento marca dónde apareció');
    assert.equal(hits[0].sectionName, 'Unidad 1: Complejidad');
    assert.deepEqual(searchCourseDocuments(USER, 999999, 'rotacion'), [], 'buscar en otra materia no ve estos documentos');
    assert.deepEqual(searchCourseDocuments(USER, COURSE, '   '), [], 'una búsqueda vacía no devuelve todo');
  }

  // ── Un intento fallido no es un archivo bajado ──
  {
    const libro = idDe('libro.pdf');
    db.prepare(
      `INSERT INTO pva_file_blob (file_id, local_path, bytes, sha256, downloaded_at, verified_at, attempts, last_error)
       VALUES (?, '', 0, '', ?, ?, 1, 'la PVA respondió 500')`
    ).run(libro, S, S);
    const doc = courseDocuments(USER, COURSE).find((entry) => entry.filename === 'libro.pdf');
    assert.equal(doc.downloaded, false, 'una fila de blob con 0 bytes es el registro de un intento, no un archivo');
    assert.equal(doc.lastError, 'la PVA respondió 500', 'y el error se dice en vez de esconderse');
    assert.equal(pendingDownloads(USER, COURSE).heavy.files, 1, 'así que sigue contando como pendiente');
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ material del aula: bajado y buscable son dos estados, el peso declarado no se hace pasar por real y el archivo de 45 MB nunca entra en "bajar lo que falta"');
