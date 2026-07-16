import { loginToPeopleSoft } from './login.js';
import fs from 'node:fs/promises';

// Script de exploración: loguea y vuelca los links/tiles del homepage de
// autoservicio para mapear qué módulos existen más allá de inscripción
// (notas, horario, cuenta financiera, holds, etc). No modifica nada.
async function main() {
  const { browser, page } = await loginToPeopleSoft({ headless: true });

  await fs.mkdir('screenshots', { recursive: true });
  await page.screenshot({ path: 'screenshots/recon-home.png', fullPage: true }).catch(() => {});

  const url = page.url();
  const title = await page.title().catch(() => '');

  // Fluid homepage: tiles con role="link" o <a>, texto visible.
  const tiles = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('a, [role="link"], [role="button"]'));
    return nodes
      .map((n) => ({
        text: n.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80),
        href: n.getAttribute('href'),
        id: n.id,
      }))
      .filter((n) => n.text && n.text.length > 1);
  });

  const out = { url, title, tileCount: tiles.length, tiles };
  await fs.writeFile('screenshots/recon-home.json', JSON.stringify(out, null, 2));

  console.log('URL:', url);
  console.log('Title:', title);
  console.log('Tiles/links encontrados:', tiles.length);
  console.log(JSON.stringify(tiles.slice(0, 60), null, 2));

  // Expandir cada groupbox (Academic Progress, Manage Classes, etc.) y
  // volcar los sub-links que aparecen adentro.
  const groupboxIds = tiles
    .filter((t) => t.id?.startsWith('win0divPTNUI_LAND_REC_GROUPLET'))
    .map((t) => t.id);

  const expanded = {};
  for (const id of groupboxIds) {
    try {
      await page.locator(`[id="${id}"]`).click({ timeout: 5000 });
      await page.waitForTimeout(1500);
      const subLinks = await page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('a, [role="link"]'));
        return nodes
          .map((n) => ({
            text: n.textContent?.trim().replace(/\s+/g, ' ').slice(0, 100),
            href: n.getAttribute('href'),
            id: n.id,
          }))
          .filter((n) => n.text && n.text.length > 1);
      });
      expanded[id] = subLinks;
      await page.screenshot({ path: `screenshots/recon-${id.replace(/[^a-z0-9]/gi, '_')}.png` }).catch(() => {});
    } catch (err) {
      expanded[id] = { error: err.message };
    }
  }

  await fs.writeFile('screenshots/recon-expanded.json', JSON.stringify(expanded, null, 2));
  console.log('--- EXPANDED ---');
  console.log(JSON.stringify(expanded, null, 2));

  await browser.close();
}

main().catch((err) => {
  console.error('Recon falló:', err.message);
  process.exit(1);
});
