#!/usr/bin/env node
// Baja el plan académico oficial de PUCMM y regenera las reglas de pénsum
// (prerrequisitos, co-requisitos, unidades y período de cada materia).
//
//   node scripts/sync-pensum-rules.mjs                 # ICC, salida por defecto
//   node scripts/sync-pensum-rules.mjs --carrera=telematica
//   node scripts/sync-pensum-rules.mjs --pdf=/ruta/local.pdf
//   node scripts/sync-pensum-rules.mjs --check         # no escribe: falla si cambió
//
// Por qué existe: ni el informe de avance, ni el Browse Catalog, ni el Class
// Search publican prerrequisitos. El único lugar público donde están es el PDF
// del plan académico que emite la Dirección del Registro. Sin él, recomendar un
// ciclo es adivinar.
//
// De dónde sale (verificado en agosto de 2026):
//   1. https://eict.pucmm.edu.do/<carrera>/ enlaza el PDF del pénsum...
//   2. ...pero alojado en el OneDrive personal de un docente, con un enlace de
//      visor (/:b:/g/personal/<user>/<token>) que responde 403 a un cliente que
//      no es un navegador. La URL que sí descarga es la de _layouts/15/
//      download.aspx?share=<token>, que se deriva del mismo token.
//
// Ese alojamiento es frágil a propósito de nadie: el token muere si el dueño
// mueve o vuelve a compartir el archivo. Por eso el enlace se re-scrapea en
// cada corrida en vez de quedar escrito acá, y por eso el JSON generado se
// versiona: si el día de mañana el enlace muere, la app sigue sabiendo el
// pénsum y solo pierde la capacidad de actualizarlo sola.
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parsePensumPlan } from '../src/shared/pensumRules.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'src', 'shared', 'pensum');

// SharePoint rechaza clientes sin User-Agent de navegador con un 403 opaco.
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const CAREERS = {
  'ciencias-computacion': { slug: 'ciencias-computacion', file: 'icc-2020.json' },
  telematica: { slug: 'telematica', file: 'itt-2020.json' },
};

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

async function get(url, { as = 'text' } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} al pedir ${url}`);
  return as === 'buffer' ? Buffer.from(await res.arrayBuffer()) : res.text();
}

// De un enlace de visor de SharePoint al de descarga directa. Los dos llevan el
// mismo token; solo cambia la ruta.
export function toDownloadUrl(shareUrl) {
  const m = shareUrl.match(/sharepoint\.com\/:[bwx]:\/g\/personal\/([^/]+)\/([^?#]+)/i);
  if (!m) return null;
  return `https://${new URL(shareUrl).host}/personal/${m[1]}/_layouts/15/download.aspx?share=${m[2]}`;
}

/** Todos los enlaces de SharePoint de una página, en el orden en que aparecen. */
export function sharePointLinks(html) {
  const links = [...html.matchAll(/href="([^"]*sharepoint\.com\/:[bwx]:\/g\/personal\/[^"]+)"/gi)].map(
    (m) => m[1].replace(/&amp;/g, '&')
  );
  return [...new Set(links)];
}

// pdfjs entrega cada fragmento con su matriz de transformación; x e y salen de
// ahí. Es lo único que este script necesita del PDF: el parser de verdad vive
// en src/shared/pensumRules.ts y no sabe que existen los PDFs.
async function pdfTextItems(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  const items = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (typeof item.str !== 'string' || !item.str.trim()) continue;
      items.push({ page: pageNumber, x: item.transform[4], y: item.transform[5], text: item.str });
    }
  }
  return items;
}

async function main() {
  const careerSlug = arg('carrera', 'ciencias-computacion');
  const career = CAREERS[careerSlug];
  if (!career) {
    throw new Error(`Carrera desconocida: ${careerSlug}. Conocidas: ${Object.keys(CAREERS).join(', ')}`);
  }

  const localPdf = arg('pdf');
  let buffer;
  let sourceUrl;

  if (localPdf) {
    buffer = await fs.readFile(localPdf);
    sourceUrl = `file://${path.resolve(localPdf)}`;
    console.log(`PDF local: ${sourceUrl}`);
  } else {
    const pageUrl = `https://eict.pucmm.edu.do/${career.slug}/`;
    console.log(`Leyendo ${pageUrl}…`);
    const links = sharePointLinks(await get(pageUrl));
    if (links.length === 0) {
      throw new Error(
        `No hay enlaces de SharePoint en ${pageUrl}. La página cambió de forma: revisá a mano dónde quedó el pénsum.`
      );
    }
    console.log(`  ${links.length} enlace(s) candidatos`);

    // La página enlaza el pénsum y el diagrama de la malla, sin distinguirlos en
    // el href. Se prueban todos y gana el primero que parsee como plan con
    // materias: el diagrama es una imagen y no produce ninguna.
    let lastError = null;
    for (const link of links) {
      const url = toDownloadUrl(link);
      if (!url) continue;
      try {
        console.log(`  probando ${url.slice(0, 90)}…`);
        const candidate = await get(url, { as: 'buffer' });
        const plan = parsePensumPlan(await pdfTextItems(candidate));
        if (Object.keys(plan.courses).length >= 20) {
          buffer = candidate;
          sourceUrl = url;
          break;
        }
        console.log(`    descartado: ${Object.keys(plan.courses).length} materia(s)`);
      } catch (err) {
        lastError = err;
        console.log(`    falló: ${err.message}`);
      }
    }
    if (!buffer) {
      throw new Error(
        `Ningún enlace de ${pageUrl} resultó ser el plan académico${lastError ? ` (último error: ${lastError.message})` : ''}`
      );
    }
  }

  const plan = parsePensumPlan(await pdfTextItems(buffer));
  const courses = Object.keys(plan.courses).length;
  if (courses < 20) {
    throw new Error(`El PDF parseó solo ${courses} materia(s): el formato del reporte cambió`);
  }

  const outFile = path.join(OUT_DIR, career.file);
  // `aliases` NO sale del PDF: es la memoria de las recodificaciones que la
  // universidad hizo entre versiones del plan y que ningún documento declara.
  // Se conserva entre corridas — regenerar las reglas no puede olvidarlas.
  let aliases = {};
  try {
    aliases = JSON.parse(await fs.readFile(outFile, 'utf8')).aliases ?? {};
  } catch {
    // Primera generación: todavía no hay nada que conservar.
  }

  const payload = {
    $comment:
      'GENERADO por scripts/sync-pensum-rules.mjs desde el plan académico oficial. No editar a mano, salvo "aliases".',
    // La nota va acá y no en el archivo generado: si viviera solo en el JSON,
    // cada regeneración la borraría y el porqué de cada alias —que no está en
    // ningún documento— se perdería en la primera actualización del pénsum.
    $aliasesComment: [
      'aliases: código del plan → códigos que la universidad usó para LA MISMA materia en otras versiones.',
      'No sale del PDF: ningún documento declara las recodificaciones. Se edita a mano y sobrevive a regenerar.',
      'MAT-110 ≡ ESG-105: mismo nombre (Razonamiento Lógico-Matemático) y mismas 4-0-4 unidades. El diagrama de malla v4 (sep-2021) la llama ESG-105; el reporte del Registro (dic-2024), MAT-110.',
      'CN-112 ≡ ESG-112 y su laboratorio: misma materia ambiental, recodificada de CN a ESG después de dic-2024.',
    ],
    source: { url: sourceUrl, fetchedAt: new Date().toISOString().slice(0, 10) },
    aliases,
    ...plan,
  };

  const json = `${JSON.stringify(payload, null, 2)}\n`;
  if (flag('check')) {
    const current = await fs.readFile(outFile, 'utf8').catch(() => '');
    // La fecha de descarga cambia en cada corrida y no es una diferencia real.
    const strip = (text) => text.replace(/"fetchedAt":\s*"[^"]*"/, '"fetchedAt": "-"');
    if (strip(current) !== strip(json)) {
      console.error(`\n${outFile} está desactualizado respecto al PDF oficial.`);
      process.exitCode = 1;
      return;
    }
    console.log(`\n${career.file}: al día con el plan oficial.`);
    return;
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(outFile, json);
  console.log(
    `\n${career.file}: plan ${plan.plan}, ${courses} materias, ${plan.periods.length} períodos, ${plan.totalUnits} unidades.`
  );
  console.log(`  con prerrequisitos: ${Object.values(plan.courses).filter((c) => c.prereqs.length).length}`);
  console.log(`  con co-requisitos:  ${Object.values(plan.courses).filter((c) => c.coreqs.length).length}`);
}

// Solo al ejecutarlo: las pruebas importan toDownloadUrl/sharePointLinks de acá
// y no pueden disparar una descarga al hacerlo.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
