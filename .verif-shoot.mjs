import { chromium } from 'playwright';
import { browserLaunchOptions } from './src/browser.js';
const BASE = 'http://localhost:4199';
const TOKEN = process.argv[2];
const ROUTES = ['/', '/mesa', '/ciclo', '/horario', '/inscripcion', '/academico', '/trayectoria', '/ajustes'];
const VIEWPORTS = [
  { name: 'phone', width: 393, height: 852 },
  { name: 'laptop', width: 1440, height: 900 },
];
const browser = await chromium.launch(await browserLaunchOptions());
const problems = [];
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
  await ctx.addCookies([{ name: 'mikampus_session', value: TOKEN, domain: 'localhost', path: '/' }]);
  const page = await ctx.newPage();
  await page.route('**/api/events', (r) => r.abort());
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`[console ${vp.name}] ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => problems.push(`[pageerror ${vp.name}] ${String(e).slice(0, 200)}`));
  for (const route of ROUTES) {
    const res = await page.goto(BASE + route, { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    const name = `${route === '/' ? 'inicio' : route.slice(1)}-${vp.name}`;
    await page.screenshot({ path: `/tmp/verif-mikampus/shots/${name}.png`, fullPage: true });
    const url = page.url().replace(BASE, '');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 120);
    console.log(`${name} http=${res.status()} url=${url} overflow=${overflow} :: ${text}`);
    if (overflow > 1) problems.push(`${name}: desborda ${overflow}px`);
  }
  await ctx.close();
}
await browser.close();
console.log('--- problemas ---');
console.log(problems.length ? problems.join('\n') : 'ninguno');
