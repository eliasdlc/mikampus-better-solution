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

// Campos de PeopleSoft que llevan estado de sesión. No son secretos de larga
// vida (mueren con la sesión), pero un token de sesión no se commitea igual.
const SENSITIVE_FIELDS = ['ICSID', 'ICStateNum', 'ICNAVTYPEDROPDOWN'];

// Los nombres de profesores NO se tocan: son públicos, están en el catálogo y
// los tests los usan. Lo que se va es lo que identifica al estudiante.
function scrub(html) {
  let out = html;
  for (const field of SENSITIVE_FIELDS) {
    out = out.replaceAll(
      new RegExp(`(id="${field}"[^>]*value=")[^"]*(")`, 'g'),
      `$1SCRUBBED_FOR_FIXTURE$2`
    );
  }
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

  // Nombre del estudiante: el portal lo pinta en la cabecera. Se lee del DOM
  // y se reemplaza en todo el documento, no solo en ese nodo.
  const nameMatch = out.match(/id="DERIVED_SSTSNAV_PERSON_NAME"[^>]*>([^<]+)/);
  if (nameMatch) {
    const name = nameMatch[1].trim();
    if (name) out = out.replaceAll(name, 'ESTUDIANTE DE PRUEBA');
  }
  return out;
}

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
