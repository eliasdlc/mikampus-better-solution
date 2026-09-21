import fs from 'node:fs/promises';
import path from 'node:path';
import { dataPaths } from './paths.js';
import { hasTeamsSession, withTeamsPage } from './teams/session.js';

// Recon de Teams, para poder escribir la descarga de transcripciones sin
// inventar un solo selector.
//
// El problema que resuelve. La transcripción de una clase existe, Elias la baja
// a mano desde la interfaz, y la vía oficial está cerrada: con permisos
// delegados el API de Microsoft Graph atiende al organizador de la reunión, que
// es el profesor, y encima el acceso de Graph a transcripciones nace apagado en
// todo tenant y lo enciende el administrador de pucmm.edu.do. Queda la
// interfaz, y una interfaz se automatiza con selectores que hay que mirar
// antes de escribir.
//
// Solo lee. Este script no hace clic en nada y no descarga ningún archivo.
//
// Privacidad, y acá importa más que en el otro recon porque lo que hay al otro
// lado son nombres de compañeros y profesores. **A la consola sale solo la
// forma**: cuántos elementos, qué `data-tid` y qué roles. El volcado va al
// directorio de datos del usuario, nunca al repo, y ya sale con el texto
// recortado a su largo. Los fixtures se derivan después, a mano, según
// docs/fixtures-policy.md.
//
// Correr: npm run recon:teams

const OUT_DIR = path.join(path.dirname(dataPaths().db), 'recon-teams');

// Las tres pantallas que hay que entender, en el orden en que un humano llega a
// la transcripción: la lista de equipos (una materia es un equipo), el canal con
// sus reuniones, y la reunión con su pestaña de transcripción.
const SCREENS = [
  { key: 'raiz', url: 'https://teams.microsoft.com/', wait: 4_000 },
  { key: 'calendario', url: 'https://teams.microsoft.com/v2/?meetings', wait: 6_000 },
];

/**
 * El esqueleto de una página: qué elementos con identidad estable hay y cuántos.
 *
 * `data-tid` es el atributo con el que Teams marca sus propios componentes y es
 * lo más parecido a un contrato que ofrece; el texto de cada nodo no se guarda,
 * solo su largo, que alcanza para distinguir "un botón" de "un nombre".
 */
async function skeleton(page) {
  return page.evaluate(() => {
    const tids = {};
    for (const node of document.querySelectorAll('[data-tid]')) {
      const tid = node.getAttribute('data-tid');
      const entry = (tids[tid] ??= { count: 0, roles: new Set(), textLengths: [] });
      entry.count += 1;
      if (node.getAttribute('role')) entry.roles.add(node.getAttribute('role'));
      entry.textLengths.push((node.textContent || '').trim().length);
    }
    const shaped = {};
    for (const [tid, entry] of Object.entries(tids)) {
      shaped[tid] = {
        count: entry.count,
        roles: [...entry.roles],
        maxTextLength: Math.max(0, ...entry.textLengths),
      };
    }
    const frames = [...document.querySelectorAll('iframe')].map((frame) => ({
      name: frame.getAttribute('name') || null,
      tid: frame.getAttribute('data-tid') || null,
    }));
    return { title: document.title.length, tids: shaped, frames, nodes: document.querySelectorAll('*').length };
  });
}

async function main() {
  if (!hasTeamsSession()) {
    console.error('No hay sesión de Teams. Corré `mikampus teams-login` una vez y volvé.');
    process.exitCode = 1;
    return;
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {};

  await withTeamsPage(async (page) => {
    for (const screen of SCREENS) {
      try {
        await page.goto(screen.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        // Teams pinta casi todo después de cargar, así que no hay un evento que
        // esperar: se le da tiempo y se mira lo que haya.
        await page.waitForTimeout(screen.wait);
        const shape = await skeleton(page);
        await fs.writeFile(path.join(OUT_DIR, `${screen.key}.json`), JSON.stringify(shape, null, 2));
        summary[screen.key] = { tids: Object.keys(shape.tids).length, nodes: shape.nodes, frames: shape.frames.length };
        console.log(`${screen.key}: ${Object.keys(shape.tids).length} data-tid distintos, ${shape.nodes} nodos`);
      } catch (err) {
        summary[screen.key] = { error: err.message };
        console.error(`${screen.key}: ${err.message}`);
      }
    }
  });

  await fs.writeFile(path.join(OUT_DIR, '_resumen.json'), JSON.stringify(summary, null, 2));
  console.log(`\nVolcado en ${OUT_DIR}. No lo subas al repositorio.`);
  console.log('El siguiente paso es derivar de ahí los selectores de la lista de reuniones');
  console.log('y del botón de descarga de la transcripción, y escribirlos en src/teams/.');
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
