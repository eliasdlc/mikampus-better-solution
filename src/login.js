import 'dotenv/config';
import { chromium } from 'playwright';

const SIGNON_URL = 'https://micampus.pucmm.edu.do/psp/cs92pro/?cmd=login&languageCd=ENG';

export async function loginToPeopleSoft({ headless = true } = {}) {
  const { PUCMM_USERNAME, PUCMM_PASSWORD } = process.env;
  if (!PUCMM_USERNAME || !PUCMM_PASSWORD) {
    throw new Error('Faltan PUCMM_USERNAME / PUCMM_PASSWORD en .env');
  }

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(SIGNON_URL, { waitUntil: 'domcontentloaded' });
  await page.fill('#userid', PUCMM_USERNAME);
  await page.fill('#pwd', PUCMM_PASSWORD);
  await page.click('input[name="Submit"]');

  // PeopleSoft no dispara una sola navegación limpia tras el submit: hace
  // varios saltos/recargas de frames en cadena. Esperamos a que la URL deje
  // de ser la de login y a que la red se calme, en vez de una sola
  // waitForNavigation que se pierde entre esos saltos intermedios.
  try {
    // 'commit' en vez del 'load' por defecto: el landing Fluid de PeopleSoft
    // tiene actividad de fondo continua y nunca dispara un 'load' limpio,
    // aunque la URL ya haya cambiado hace rato.
    await page.waitForURL((url) => !url.href.includes('cmd=login'), {
      timeout: 45000,
      waitUntil: 'commit',
    });
  } catch {
    const loginError = await page.locator('#login_error').textContent().catch(() => '');
    await page.screenshot({ path: 'screenshots/login-timeout.png', timeout: 5000 }).catch(() => {});
    await browser.close();
    if (loginError && loginError.trim().length > 0) {
      throw new Error(`Login falló: ${loginError.trim()}`);
    }
    throw new Error('Timeout esperando redirección post-login. Ver screenshots/login-timeout.png');
  }

  return { browser, context, page };
}
