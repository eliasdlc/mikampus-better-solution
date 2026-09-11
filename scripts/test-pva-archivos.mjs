// Los materiales del aula: cosecha, descarga y texto buscable. Sin red.
//
// Lo que esta prueba fija son las trampas que ya costaron un hallazgo: las dos
// plantillas de ruta de pluginfile, el 200 con basura que hay que detectar
// ANTES de escribir a disco, el ETag como única señal de cambio (timemodified
// miente), el enlace externo que jamás puede recibir el token, y el archivo
// que no deja texto, que se guarda igual y se dice por qué.
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import fs from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-pva-files-'));
process.env.MIKAMPUS_DATA_DIR = dir;
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_CREDENTIALS_FILE = path.join(dir, 'credenciales.env');

const { db } = await import('../src/db.js');
const { dataPaths } = await import('../src/paths.js');
const { writeCredential, writePvaAccessKey, writePvaToken } = await import('../src/credentialStore.js');
const { saveIdentity } = await import('../src/moodle/identity.js');
const { saveCourses, saveCourseContents } = await import('../src/moodle/courses.js');
const { saveAssignments } = await import('../src/moodle/assignments.js');
const { readZipIndex, readZipEntries } = await import('../src/moodle/zip.js');
const { extractText, extractorFor, htmlToText } = await import('../src/moodle/extract.js');
const {
  parsePluginfileUrl,
  downloadUrlFor,
  downloadFile,
  syncFiles,
  filesToFetch,
  filesUsage,
  searchFiles,
  courseLinks,
  setFileLimits,
} = await import('../src/moodle/files.js');

const fixture = async (name) => JSON.parse(await readFile(`fixtures/${name}`, 'utf8'));
const USER = 1;
const NOW = 1_771_900_000_000;

// ── Un zip de verdad, armado acá: así el lector se prueba contra el formato y
// no contra un binario commiteado que nadie puede revisar en un diff.
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, store = false } of entries) {
    const raw = Buffer.from(data);
    const body = store ? raw : zlib.deflateRawSync(raw);
    const nameBuffer = Buffer.from(name, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(raw) : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(local, nameBuffer, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

const docx = (text) =>
  buildZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">segundo p&#225;rrafo</w:t></w:r></w:p></w:body></w:document>` },
  ]);

const pptx = () =>
  buildZip([
    { name: 'ppt/slides/slide2.xml', data: '<p:sld><a:p><a:r><a:t>Diapositiva dos</a:t></a:r></a:p></p:sld>' },
    { name: 'ppt/slides/slide10.xml', data: '<p:sld><a:p><a:r><a:t>Diapositiva diez</a:t></a:r></a:p></p:sld>' },
    { name: 'ppt/slides/slide1.xml', data: '<p:sld><a:p><a:r><a:t>Diapositiva uno</a:t></a:r></a:p></p:sld>' },
  ]);

// Un servidor de mentira: entrega el cuerpo que se le diga, con sus cabeceras,
// y anota qué URL le pidieron.
function server(responses) {
  const asked = [];
  const fetchImpl = async (url, init = {}) => {
    asked.push({ url, headers: init.headers ?? {} });
    const next = typeof responses === 'function' ? responses(url, init, asked.length) : responses;
    return next;
  };
  return { fetchImpl, asked };
}

const body = (buffer, { status = 200, type = 'application/pdf', etag = '"abc123"', extra = {} } = {}) =>
  new Response(status === 304 ? null : buffer, {
    status,
    headers: { 'content-type': type, etag, 'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT', ...extra },
  });

try {
  // ── El lector de zip ──
  {
    const zip = buildZip([
      { name: 'a.txt', data: 'comprimido con deflate' },
      { name: 'b.txt', data: 'almacenado sin comprimir', store: true },
    ]);
    const index = readZipIndex(zip);
    assert.deepEqual(index.map((entry) => entry.name), ['a.txt', 'b.txt']);
    assert.deepEqual(index.map((entry) => entry.method), [8, 0], 'los dos métodos que escriben Word y PowerPoint');
    const leidos = readZipEntries(zip, () => true).map((entry) => entry.data.toString('utf8'));
    assert.deepEqual(leidos, ['comprimido con deflate', 'almacenado sin comprimir']);
    assert.throws(() => readZipIndex(Buffer.from('esto no es un zip')), /No parece un zip/);
  }

  // ── Extracción ──
  {
    const word = await extractText(docx('Primer párrafo con acentos'), {
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    assert.equal(word.indexed, true);
    assert.equal(word.extractor, 'docx');
    assert.equal(word.text, 'Primer párrafo con acentos\nsegundo párrafo', 'cada párrafo en su línea y las entidades decodificadas');

    const slides = await extractText(pptx(), {
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    assert.equal(slides.pages, 3);
    assert.deepEqual(
      slides.text.split('\n'),
      ['Diapositiva uno', 'Diapositiva dos', 'Diapositiva diez'],
      'las diapositivas van en orden natural, no en el orden del zip ni alfabético'
    );

    // El index.html de una página: llega sin mimetype y con filesize 0, y es el
    // contenido de mayor valor por byte del dominio.
    const pagina = await extractText(Buffer.from('<div class="no-overflow"><p>La derivada de una <b>constante</b></p></div>'), {
      contentType: 'text/html;charset=UTF-8',
      filename: 'index.html',
    });
    assert.equal(pagina.text, 'La derivada de una constante');

    // Lo que no se puede leer se dice, no se finge.
    const imagen = await extractText(Buffer.from('binario'), { mimetype: 'image/jpeg', filename: 'pizarra.jpg' });
    assert.equal(imagen.indexed, false);
    assert.match(imagen.reason, /OCR/);
    const viejo = await extractText(Buffer.from('binario'), { mimetype: 'application/msword', filename: 'guia.doc' });
    assert.equal(viejo.indexed, false);
    // Un zip corrupto no puede tumbar la corrida entera.
    const roto = await extractText(Buffer.from('no soy un docx'), { filename: 'roto.docx' });
    assert.equal(roto.indexed, false);
    assert.match(roto.reason, /No se pudo extraer/);

    // Un PDF de verdad, armado acá: es el 82% de los bytes del dominio y el
    // formato del que más depende esta fase.
    const flujo = 'BT /F1 12 Tf 20 200 Td (La integral definida de una funcion) Tj ET';
    const pdf = Buffer.from(
      [
        '%PDF-1.4',
        '1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj',
        '2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj',
        '3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>> endobj',
        `4 0 obj <</Length ${flujo.length}>> stream`,
        flujo,
        'endstream endobj',
        '5 0 obj <</Type/Font/Subtype/Type1/BaseFont/Helvetica>> endobj',
        'trailer <</Root 1 0 R/Size 6>>',
        '%%EOF',
      ].join('\n'),
      'latin1'
    );
    const extraido = await extractText(pdf, { contentType: 'application/pdf', filename: 'apunte.pdf' });
    assert.equal(extraido.extractor, 'pdf');
    assert.equal(extraido.pages, 1);
    assert.equal(extraido.text, 'La integral definida de una funcion');

    assert.equal(extractorFor({ filename: 'sin-extension' }), 'desconocido', 'y sin tipo ni extensión, no se adivina');
    assert.equal(htmlToText('<p>uno</p><p>dos</p>'), 'uno\ndos');
  }

  // ── Las dos plantillas de ruta ──
  {
    const conItem = parsePluginfileUrl('https://x/moodle/webservice/pluginfile.php/990003/mod_resource/content/7/lectura%2001.pdf?forcedownload=1');
    assert.equal(conItem.itemId, 7);
    assert.equal(conItem.revision, 7, 'en mod_resource ese número es una revisión, no un itemid');
    assert.equal(conItem.filename, 'lectura 01.pdf', 'el último segmento viene percent-encoded');
    assert.equal(conItem.forceDownload, 1);
    assert.equal(conItem.base.includes('?'), false, 'la query no forma parte de la identidad');

    const sinItem = parsePluginfileUrl('https://x/moodle/webservice/pluginfile.php/990010/mod_page/content/index.html');
    assert.equal(sinItem.itemId, null, 'mod_page no trae itemid: un parse posicional metería el nombre en la columna equivocada');
    assert.equal(sinItem.filename, 'index.html');
    assert.equal(parsePluginfileUrl('https://ejemplo.com/algo.pdf'), null, 'una URL externa no es un pluginfile');
  }

  // ── Sembrado ──
  writeCredential({ username: 'ab123456', password: 'x' });
  saveIdentity(USER, await fixture('pva-site-info.json'));
  saveCourses(USER, await fixture('pva-courses.json'), { now: NOW });
  const harvested = saveCourseContents(USER, 800101, await fixture('pva-contents.json'), { now: NOW });
  const assignments = saveAssignments(USER, await fixture('pva-assignments.json'), { now: NOW });

  // ── La cosecha ──
  {
    assert.equal(harvested.files, 1, 'el resource del fixture trae un archivo');
    assert.equal(harvested.links >= 0, true);
    assert.equal(assignments.files >= 0, true, 'los adjuntos del enunciado se anotan con su propia forma');

    const file = db.prepare('SELECT * FROM pva_file WHERE user_id = ?').get(USER);
    assert.equal(file.component, 'mod_resource');
    assert.equal(file.area, 'content');
    assert.equal(file.filename, 'lectura-01.pdf');
    assert.equal(file.filesize, 205785, 'el tamaño DECLARADO se guarda tal cual');

    const info = db.prepare('SELECT * FROM pva_module_contents_info WHERE cmid = 910003').get();
    assert.ok(info, 'el resumen por módulo sirve para decidir si vale la pena abrirlo');

    // Volver a guardar el mismo árbol no duplica: la identidad no es la URL.
    saveCourseContents(USER, 800101, await fixture('pva-contents.json'), { now: NOW + 1000 });
    assert.equal(db.prepare('SELECT count(*) AS n FROM pva_file WHERE user_id = ?').get(USER).n, 1);

    // Y una revisión nueva del mismo fichero actualiza la fila, no crea otra.
    const contents = await fixture('pva-contents.json');
    const resource = contents[0].modules.find((module) => module.modname === 'resource');
    resource.contents[0].fileurl = resource.contents[0].fileurl.replace('/content/1/', '/content/9/');
    saveCourseContents(USER, 800101, contents, { now: NOW + 2000 });
    const filas = db.prepare('SELECT file_id, revision FROM pva_file WHERE user_id = ?').all(USER);
    assert.equal(filas.length, 1, 'reemplazar el fichero cambia la revisión, no la identidad');
    assert.equal(filas[0].revision, 9);
  }

  // ── El enlace externo nunca recibe el token ──
  {
    const links = courseLinks(USER, 800101);
    const externo = links.find((link) => !link.url.includes('campusvirtual'));
    if (externo) {
      assert.ok(externo.host, 'se guarda el host para poder decir a dónde lleva');
      assert.equal(
        db.prepare('SELECT count(*) AS n FROM pva_file WHERE fileurl = ?').get(externo.url).n,
        0,
        'y no está entre los archivos: ninguna función de descarga lo puede tocar'
      );
    }
  }

  // ── La URL de descarga ──
  {
    const file = db.prepare('SELECT * FROM pva_file WHERE user_id = ?').get(USER);
    writePvaToken('token-de-prueba');
    assert.match(downloadUrlFor(file, { token: 'token-de-prueba' }), /[?&]token=token-de-prueba/, 'el parámetro es token, no wstoken');
    writePvaAccessKey('LLAVE-PRIVADA');
    const conLlave = downloadUrlFor(file, { accessKey: 'LLAVE-PRIVADA' });
    assert.match(conLlave, /\/tokenpluginfile\.php\/LLAVE-PRIVADA\//, 'con llave se usa la ruta que no deja el token en la query');
    assert.equal(conLlave.includes('token='), false);
  }

  // ── La descarga ──
  {
    const file = db.prepare('SELECT * FROM pva_file WHERE user_id = ?').get(USER);
    const pdf = Buffer.from('%PDF-1.7 contenido que no es un pdf real');

    // 200: se guarda, con su ETag y su sha256.
    const ok = server(() => body(pdf, { etag: '"v1"' }));
    const primera = await downloadFile(USER, file, { fetchImpl: ok.fetchImpl, now: NOW });
    assert.equal(primera.outcome, 'downloaded');
    assert.equal(primera.bytes, pdf.length);
    const blob = db.prepare('SELECT * FROM pva_file_blob WHERE file_id = ?').get(file.file_id);
    assert.equal(blob.etag, '"v1"');
    assert.ok(fs.existsSync(blob.local_path), 'el archivo quedó en disco');
    assert.ok(blob.local_path.startsWith(dataPaths().pvaFiles), 'y dentro del directorio de datos, nunca en el repo');
    assert.equal(path.basename(blob.local_path), blob.sha256, 'el nombre de disco es el sha: 44 nombres para 54 ficheros, hay colisiones');

    // 304: no se vuelve a escribir nada, solo se refresca la verificación.
    const revalidacion = server(() => body(null, { status: 304, etag: '"v1"' }));
    const segunda = await downloadFile(USER, file, { fetchImpl: revalidacion.fetchImpl, now: NOW + 60_000 });
    assert.equal(segunda.outcome, 'unchanged');
    assert.equal(revalidacion.asked[0].headers['If-None-Match'], '"v1"', 'se pide condicional: el ETag es la única señal fiable');

    // 200 con el mismo contenido: no reescribe el disco.
    const iguales = server(() => body(pdf, { etag: '"v2"' }));
    const tercera = await downloadFile(USER, file, { fetchImpl: iguales.fetchImpl, now: NOW + 120_000 });
    assert.equal(tercera.outcome, 'unchanged', 'mismo sha256, aunque el ETag haya cambiado');

    // 200 con JSON adentro: es un error disfrazado y no se escribe un byte.
    const bytesAntes = fs.readFileSync(blob.local_path).length;
    const disfrazado = server(() => body(Buffer.from('{"errorcode":"invalidtoken"}'), { type: 'application/json' }));
    await assert.rejects(
      downloadFile(USER, file, { fetchImpl: disfrazado.fetchImpl, now: NOW }),
      /invalidtoken/,
      'un 200 con JSON es una excepción de Moodle, no un archivo'
    );
    assert.equal(fs.readFileSync(blob.local_path).length, bytesAntes, 'y el archivo bueno sigue intacto');

    // 200 con la pantalla de login: se reconoce porque es un DOCUMENTO
    // completo. El HTML de una página de curso es un fragmento y sí es válido:
    // rechazar todo el HTML rompería el contenido de más valor del dominio.
    const login = server(() => body(Buffer.from('<!DOCTYPE html><html><body>login</body></html>'), { type: 'text/html' }));
    await assert.rejects(downloadFile(USER, file, { fetchImpl: login.fetchImpl, now: NOW }), /login/);
    const pagina = server(() => body(Buffer.from('<div class="no-overflow"><p>contenido</p></div>'), { type: 'text/html;charset=UTF-8', etag: '"pag"' }));
    const fragmento = await downloadFile(USER, file, { fetchImpl: pagina.fetchImpl, now: NOW });
    assert.equal(fragmento.outcome, 'downloaded', 'el index.html de una página es un archivo legítimo');

    // Más grande que el tope: se anota y no se guarda a medias.
    const gordo = server(() => body(Buffer.alloc(3 * 1024 * 1024, 1), { etag: '"grande"' }));
    const saltado = await downloadFile(USER, file, { fetchImpl: gordo.fetchImpl, now: NOW, maxFileBytes: 1024 });
    assert.equal(saltado.outcome, 'skipped');
    assert.match(db.prepare('SELECT last_error AS e FROM pva_file_blob WHERE file_id = ?').get(file.file_id).e, /tope/);
  }

  // ── La corrida completa, con presupuesto e índice ──
  {
    db.prepare('DELETE FROM pva_file_blob').run();
    db.prepare('DELETE FROM pva_file_text').run();
    db.exec("INSERT INTO pva_file_text_fts (pva_file_text_fts) VALUES ('delete-all')");

    const html = Buffer.from('<div class="no-overflow"><p>La integral definida de una función continua</p></div>');
    const corrida = server(() => body(html, { type: 'text/html;charset=UTF-8', etag: '"pagina"' }));
    const resultado = await syncFiles(USER, { fetchImpl: corrida.fetchImpl, now: NOW });
    assert.equal(resultado.downloaded >= 1, true);
    assert.equal(resultado.indexed >= 1, true, 'lo que se baja se indexa en la misma pasada');

    const hits = searchFiles(USER, '"integral"');
    assert.equal(hits.length, 1, 'y queda buscable');
    assert.match(hits[0].snippet, /«integral»/, 'con el fragmento donde aparece');
    assert.equal(searchFiles(USER, '"funcion"').length, 1, 'la búsqueda ignora acentos');

    const usage = filesUsage(USER);
    assert.equal(usage.files >= 1, true);
    assert.equal(usage.indexed >= 1, true);
    assert.ok(usage.remainingBytes < usage.budgetBytes, 'el contador de presupuesto se mueve');

    // Nada pendiente justo después: no se vuelve a pedir dentro del caché.
    assert.equal(filesToFetch(USER, { now: NOW }).length, 0);
    assert.equal(filesToFetch(USER, { now: NOW + 7 * 3600 * 1000 }).length >= 1, true, 'pasado el caché del servidor sí se revalida');

    // Con el presupuesto agotado no se baja nada.
    setFileLimits({ budgetMb: 1 });
    db.prepare('UPDATE pva_file_blob SET bytes = ?, verified_at = 0').run(2 * 1024 * 1024);
    const sinPresupuesto = await syncFiles(USER, { fetchImpl: corrida.fetchImpl, now: NOW + 8 * 3600 * 1000 });
    assert.equal(sinPresupuesto.downloaded, 0, 'el tope de disco se respeta');
    assert.ok(sinPresupuesto.skipped >= 1);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ archivos de la PVA: las dos plantillas de ruta, el 200 con basura detectado antes de escribir, ETag como delta y texto buscable');
