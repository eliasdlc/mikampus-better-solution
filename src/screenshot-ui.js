import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
await page.goto('http://localhost:4173', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(12000);
await page.screenshot({ path: 'screenshots/dashboard.png', fullPage: true });
await browser.close();
console.log('listo');
