import 'dotenv/config';
import { chromium } from 'playwright';
import { getCredentials } from './credentials.js';

const SIGNON_URL = 'https://micampus.pucmm.edu.do/psp/cs92pro/?cmd=login&languageCd=ENG';

// Llena un campo y confirma que el valor quedó, reintentando si el JS del
// portal lo pisó. Limpia antes de escribir para no concatenar sobre lo que el
// signon haya dejado en el campo durante su inicialización.
async function fillVerified(page, selector, value, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    await page.locator(selector).click();
    await page.fill(selector, '');
    await page.fill(selector, value);
    if ((await page.inputValue(selector)) === value) return;
    await page.waitForTimeout(400);
  }
  throw new Error(`No se pudo llenar ${selector} de forma estable en el signon`);
}

export async function loginToPeopleSoft({ headless = true } = {}) {
  // Las credenciales salen de credentials.js (data/account.json si la página
  // cambió de cuenta, si no el .env), no de process.env directo: así cambiar de
  // cuenta desde la web tiene efecto sin reiniciar el proceso.
  const { username, password } = getCredentials();
  if (!username || !password) {
    throw new Error('No hay cuenta configurada: seteala en Ajustes o en el .env');
  }

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(SIGNON_URL, { waitUntil: 'domcontentloaded' });

  // El signon corre JS de inicialización al cargar que pisa los campos si se
  // llenan demasiado pronto: el userid queda concatenado con basura y el pwd
  // vacío, y el portal rechaza el submit con "User ID and Password are
  // required". Esperamos a que los campos estén visibles y verificamos el
  // valor tras llenar, reintentando si el portal lo alteró.
  await page.waitForSelector('#userid', { state: 'visible' });
  await page.waitForSelector('#pwd', { state: 'visible' });
  await fillVerified(page, '#userid', username);
  await fillVerified(page, '#pwd', password);
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
