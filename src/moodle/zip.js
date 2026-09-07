import zlib from 'node:zlib';

// Lector mínimo de ZIP, solo lo que hace falta para abrir un .docx o un .pptx.
//
// Es una dependencia que no se agrega: un docx es un zip con XML adentro, y
// leerlo son las setenta líneas de abajo contra node:zlib. Lo que NO cubre, y
// se dice en vez de fallar raro: ZIP64 (archivos de más de 4 GiB o con más de
// 65535 entradas) y los métodos de compresión que no sean "almacenado" (0) y
// "deflate" (8). Word y PowerPoint escriben siempre deflate, así que el resto
// sería un archivo armado por otra herramienta.
//
// Los tamaños se leen del directorio central y no de la cabecera local: cuando
// el escritor usa descriptor de datos, la cabecera local trae ceros y quien
// confíe en ella lee un archivo vacío sin enterarse.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_COMMENT = 0xffff;

function findEndOfCentralDirectory(buffer) {
  const earliest = Math.max(0, buffer.length - MAX_COMMENT - 22);
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

/**
 * El índice del zip: nombre, método, tamaños y dónde empieza cada entrada.
 * No descomprime nada todavía.
 */
export function readZipIndex(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error('No parece un zip: no encontré el directorio central');
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff) throw new Error('Zip en formato ZIP64: este lector no lo cubre');

  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.push({ name, method, compressedSize, size, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** El contenido de una entrada, descomprimido. */
export function readZipEntry(buffer, entry) {
  if (buffer.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) {
    throw new Error(`Cabecera local corrupta en ${entry.name}`);
  }
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`Método de compresión ${entry.method} no soportado en ${entry.name}`);
}

/**
 * Las entradas cuyo nombre pasa el filtro, ya descomprimidas y en orden de
 * nombre. El orden importa en un pptx: las diapositivas se llaman slide1,
 * slide2, ... y el orden del zip no tiene por qué ser el de la presentación.
 */
export function readZipEntries(buffer, matches) {
  return readZipIndex(buffer)
    .filter((entry) => matches(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name, 'en', { numeric: true }))
    .map((entry) => ({ name: entry.name, data: readZipEntry(buffer, entry) }));
}
