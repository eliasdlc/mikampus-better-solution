// Genera los iconos de la PWA. Se generan en vez de commitear PNGs a mano
// porque así el icono deriva del sistema de diseño (mismo Bricolage, mismo
// tinta-sobre-papel) y no de un binario que nadie sabe cómo regenerar.
//
//   node scripts/make-icons.mjs
//
// Corre solo cuando el icono cambia; el resultado vive en web/public/.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const OUT = 'web/public';
// 192 y 512 son los dos tamaños que Chrome exige para considerar instalable una
// app; 180 es el apple-touch-icon de iOS.
const SIZES = [192, 512, 180];

// maskable: Android recorta el icono a la forma del launcher (círculo, squircle)
// y solo respeta el 80% central. La "m" va chica y centrada a propósito, o el
// recorte se la come.
const html = (size) => `
<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.bunny.net/css?family=bricolage-grotesque:700">
<style>
  html, body { margin: 0; }
  .icon {
    width: ${size}px;
    height: ${size}px;
    display: grid;
    place-items: center;
    background: #16181d;
    color: #f7f7f5;
    font-family: 'Bricolage Grotesque', system-ui, sans-serif;
    font-weight: 700;
    font-size: ${size * 0.42}px;
    letter-spacing: -0.04em;
  }
</style>
<div class="icon">mk</div>
`;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  for (const size of SIZES) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(html(size), { waitUntil: 'networkidle' });
    const name = size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`;
    await page.screenshot({ path: `${OUT}/${name}`, omitBackground: false });
    await page.close();
    console.log(`✓ ${OUT}/${name}`);
  }
} finally {
  await browser.close();
}
