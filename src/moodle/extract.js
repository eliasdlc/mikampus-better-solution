import { readZipEntries } from './zip.js';

// Extracción de texto de un material del aula.
//
// El objetivo de la fase es poder estudiar sin abrir la PVA, así que lo que
// importa no es cubrir todos los formatos: es cubrir los que tienen el texto y
// decir con todas las letras cuáles no. Un archivo que no se puede extraer se
// guarda igual y se marca como no indexado, con su razón; fingir que se indexó
// es lo que haría que una búsqueda vacía pareciera "no está en tus materiales".
//
// Reparto medido en el recon, sobre 39 archivos con texto:
//   pdf 32 (71 MiB) · docx 4 · pptx 2 · el index.html de las páginas 11
// Los 11 index.html llegan sin mimetype y con filesize 0 y pesan hasta 29 KB:
// son el contenido de mayor valor por byte de todo el dominio.

/** Lo que decide el extractor: el tipo real de la respuesta manda sobre el declarado. */
export function extractorFor({ contentType = null, mimetype = null, filename = '' } = {}) {
  const type = String(contentType ?? mimetype ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (type === 'application/pdf') return 'pdf';
  if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (type === 'text/markdown') return 'text';
  if (type.startsWith('text/')) return 'text';
  if (type === 'application/msword') return 'doc';
  if (type.startsWith('image/')) return 'imagen';
  // Sin tipo fiable queda la extensión, que en este dominio miente: 45 de 96
  // nombres no traen punto. Solo se usa como último recurso.
  const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? '';
  if (extension === 'pdf') return 'pdf';
  if (extension === 'docx') return 'docx';
  if (extension === 'pptx') return 'pptx';
  if (extension === 'html' || extension === 'htm') return 'html';
  if (extension === 'txt' || extension === 'md') return 'text';
  if (extension === 'doc') return 'doc';
  return 'desconocido';
}

// Por qué un formato no se indexa. Sale tal cual a la respuesta del MCP, así
// que está escrito para que alguien lo lea, no para un log.
const NOT_INDEXABLE = {
  imagen: 'Es una imagen: haría falta OCR, que no vale la pena por defecto.',
  doc: 'Es un .doc binario viejo: haría falta antiword o LibreOffice para leerlo.',
  desconocido: 'No hay extractor para ese tipo de archivo.',
};

const WHITESPACE = /[\t ​]+/g;

/** Normaliza el texto extraído: sin líneas vacías de más y sin espacios raros. */
export function normalizeText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(WHITESPACE, ' ')
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n')
    .trim();
}

// Las entidades que de verdad aparecen en el HTML de la PVA. No se hace un
// decodificador completo: lo que viene es un fragmento de Moodle, no la web.
const ENTITIES = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ndash: '-',
  mdash: '-',
  hellip: '...',
};

export function htmlToText(html) {
  const withoutInvisible = String(html ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  const withBreaks = withoutInvisible
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ');
  const stripped = withBreaks.replace(/<[^>]+>/g, ' ');
  const decoded = stripped
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);
  return normalizeText(decoded);
}

// En OOXML el texto vive en <w:t> (Word) y <a:t> (PowerPoint), y los saltos de
// párrafo son elementos y no texto. Se recorre el XML EN ORDEN, tomando los
// nodos de texto y los cierres de párrafo tal como aparecen: reconstruirlo en
// dos pasadas (primero los textos, después los saltos) pierde dónde caían.
const OOXML_TOKEN = /<(?:w|a):t(?:\s[^>]*)?>([\s\S]*?)<\/(?:w|a):t>|<\/(?:w|a):p>|<w:br\b[^>]*\/?>|<w:tab\b[^>]*\/?>/g;

function decodeXmlEntities(value) {
  return String(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&(amp|lt|gt|quot|apos);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);
}

function ooxmlToText(xml) {
  const pieces = [];
  for (const match of String(xml).matchAll(OOXML_TOKEN)) {
    if (match[1] !== undefined) pieces.push(decodeXmlEntities(match[1]));
    else if (match[0].startsWith('<w:tab')) pieces.push(' ');
    else pieces.push('\n');
  }
  return normalizeText(pieces.join(''));
}

async function extractPdf(buffer) {
  // pdfjs se carga solo cuando hace falta: son 37 MB de paquete y un usuario
  // que nunca abre un PDF no tiene por qué pagar el arranque.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    // Sin evaluación de JavaScript embebido: un PDF de un tercero no ejecuta
    // nada acá, y de un apunte solo se quiere el texto.
    isEvalSupported: false,
    // pdfjs avisa por stderr cada vez que reconstruye el índice de un PDF mal
    // cerrado, que es la mitad de lo que sube un profesor. Es ruido, no señal.
    verbosity: 0,
  }).promise;
  const pages = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str ?? '').join(' '));
  }
  await doc.destroy();
  return { text: normalizeText(pages.join('\n')), pages: doc.numPages };
}

/**
 * Extrae el texto de un material. Nunca lanza por un archivo ilegible: devuelve
 * `indexed: false` con la razón, porque un archivo que no se puede leer sigue
 * siendo un archivo que el estudiante tiene.
 */
export async function extractText(buffer, { contentType = null, mimetype = null, filename = '' } = {}) {
  const extractor = extractorFor({ contentType, mimetype, filename });
  if (NOT_INDEXABLE[extractor]) return { indexed: false, extractor, reason: NOT_INDEXABLE[extractor], text: '', pages: null };

  try {
    if (extractor === 'pdf') {
      const { text, pages } = await extractPdf(buffer);
      return { indexed: text.length > 0, extractor, text, pages, reason: text ? null : 'El PDF no tiene capa de texto: sería un escaneo.' };
    }
    if (extractor === 'docx') {
      const parts = readZipEntries(buffer, (name) => name === 'word/document.xml');
      const text = parts.map((part) => ooxmlToText(part.data.toString('utf8'))).join('\n');
      return { indexed: text.length > 0, extractor, text, pages: null, reason: text ? null : 'El documento no trae texto.' };
    }
    if (extractor === 'pptx') {
      const slides = readZipEntries(buffer, (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
      const text = slides.map((slide) => ooxmlToText(slide.data.toString('utf8'))).join('\n');
      return { indexed: text.length > 0, extractor, text, pages: slides.length, reason: text ? null : 'La presentación no trae texto.' };
    }
    if (extractor === 'html') {
      const text = htmlToText(buffer.toString('utf8'));
      return { indexed: text.length > 0, extractor, text, pages: null, reason: text ? null : 'La página está vacía.' };
    }
    const text = normalizeText(buffer.toString('utf8'));
    return { indexed: text.length > 0, extractor: 'text', text, pages: null, reason: text ? null : 'El archivo está vacío.' };
  } catch (err) {
    // Un archivo corrupto o un formato inesperado no puede tumbar la corrida
    // entera: se marca ese archivo y el resto sigue.
    return { indexed: false, extractor, text: '', pages: null, reason: `No se pudo extraer: ${err.message}` };
  }
}
