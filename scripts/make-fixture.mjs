// Convierte un volcado de recon (screenshots/, ignorado por git) en un fixture
// versionable (fixtures/, commiteado). Los volcados salen de una sesión real
// logueada: antes de que entren al repo hay que sacarles los tokens de sesión.
//
//   node scripts/make-fixture.mjs screenshots/recon-catalog-ICC3.html
//
// Los fixtures son la referencia de selectores del plan (riesgo #1: PeopleSoft
// cambia IDs entre parches) y lo que hace que los tests corran sin portal.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Campos de PeopleSoft que llevan estado de sesión. No son secretos de larga
// vida (mueren con la sesión), pero un token de sesión no se commitea igual.
const SENSITIVE_FIELDS = ['ICSID', 'ICStateNum', 'ICNAVTYPEDROPDOWN'];

// Los nombres de profesores NO se tocan: son públicos, están en el catálogo y
// los tests los usan. Lo que se va es lo que identifica al estudiante.
export function scrub(html) {
  let out = html;
  // PeopleSoft changes the attribute order between pages. Sanitizing each input
  // tag means `value` is removed whether it appears before or after `id`/`name`.
  out = out.replace(/<input\b[^>]*>/gi, (tag) => {
    const isSensitive = SENSITIVE_FIELDS.some((field) =>
      new RegExp(`\\b(?:id|name)\\s*=\\s*(["'])${field}\\1`, 'i').test(tag)
    );
    return isSensitive
      ? tag.replace(/(\bvalue\s*=\s*)(["'])[^"']*\2/i, '$1$2SCRUBBED_FOR_FIXTURE$2')
      : tag;
  });
  // Red de seguridad: cualquier otro hidden con pinta de token (base64 largo).
  out = out.replace(
    /(<input[^>]*type="hidden"[^>]*value=")([A-Za-z0-9+/]{24,}={0,2})(")/g,
    '$1SCRUBBED_FOR_FIXTURE$3'
  );

  // Matrícula del estudiante. Aparece en dos formatos: en los href de la barra
  // de navegación (EMPLID=123) y en el objeto JS PIA_KEYSTRUCT (EMPLID:"123").
  // El resto de ese objeto (STRM, ACAD_CAREER) se conserva: no identifica a
  // nadie y es de donde el scraper saca el código de término.
  out = out.replace(/EMPLID=\d+/g, 'EMPLID=00000000');
  out = out.replace(/EMPLID:"\d+"/g, 'EMPLID:"00000000"');
  // Identificador de la transacción de inscripción generado para una cuenta.
  // No permite loguearse, pero sí enlaza el fixture con una operación real.
  out = out.replace(/ENRL_REQUEST_ID=\d+/g, 'ENRL_REQUEST_ID=0000000000');
  out = out.replace(/ENRL_REQUEST_ID:"\d+"/g, 'ENRL_REQUEST_ID:"0000000000"');

  // Nombre del estudiante. No hay un solo nodo que lo tenga: las pantallas
  // clásicas lo ponen en la cabecera de navegación, pero el Student Center no
  // la trae y solo lo pinta en su título ("ELÍAS's Student Center"). Con una
  // sola fuente, ese volcado se escapa entero.
  const NAME_SOURCES = [
    /id="DERIVED_SSTSNAV_PERSON_NAME"[^>]*>([^<]+)/,
    /id="DERIVED_SSS_SCL_TITLE1[^"]*"[^>]*>([^<]+?)'s Student Center/,
  ];
  for (const source of NAME_SOURCES) {
    const nameMatch = out.match(source);
    if (!nameMatch) continue;
    const rawName = nameMatch[1].trim();
    const name = rawName.replace(/&nbsp;/g, ' ').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
    if (name) {
      out = out.replaceAll(rawName, 'ESTUDIANTE DE PRUEBA');
      out = out.replaceAll(name, 'ESTUDIANTE DE PRUEBA');
      // Y cada parte por separado, porque el portal usa el nombre de pila solo
      // en varios lugares. Si de paso se lleva el apellido de un profesor que
      // se llame igual, no importa: un fixture con un profesor anonimizado de
      // más es barato; uno con el nombre del estudiante, no.
      for (const part of name.split(' ')) {
        if (part.length >= 3) {
          out = out.replaceAll(new RegExp(`(?<![\\p{L}])${part}(?![\\p{L}])`, 'giu'), 'ESTUDIANTE');
        }
      }
    }
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input] = process.argv.slice(2);
  if (!input) {
    console.error('Uso: node scripts/make-fixture.mjs <volcado.html>');
    process.exit(1);
  }

  const html = await readFile(input, 'utf8');
  const cleaned = scrub(html);

  await mkdir('fixtures', { recursive: true });
  const output = path.join('fixtures', path.basename(input));
  await writeFile(output, cleaned);

  const scrubbed = (cleaned.match(/SCRUBBED_FOR_FIXTURE/g) ?? []).length;
  console.log(`${input} → ${output} (${scrubbed} valor(es) de sesión removidos)`);
}
