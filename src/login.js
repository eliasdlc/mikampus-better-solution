import 'dotenv/config';
import { chromium } from 'playwright';
import { captureFailure } from './diagnostics.js';
import { browserLaunchOptions } from './browser.js';

const SIGNON_URL = 'https://micampus.pucmm.edu.do/psp/cs92pro/?cmd=login&languageCd=ENG';

// Playwright escribe el VALOR dentro del mensaje de error de `fill()`:
// `fill("...")`. Ese mensaje sube hasta la pantalla de login y se pinta en
// rojo, así que sin esto la contraseña del portal se muestra en claro en la
// interfaz y queda en cualquier log que la copie. Es la misma regla que el
// token de la PVA: una credencial nunca sale en un mensaje de error.
export function scrubSecret(text, secret) {
  const message = String(text ?? '');
  if (!secret) return message;
  return message.split(String(secret)).join('[contraseña oculta]');
}

function rethrowWithoutSecret(err, secret) {
  const clean = new Error(scrubSecret(err?.message, secret));
  // Las banderas que el resto de mikampus mira para decidir si reintentar o
  // pedir credencial de nuevo tienen que sobrevivir al saneo.
  clean.credentialRejected = err?.credentialRejected;
  clean.beforeSubmit = err?.beforeSubmit;
  clean.name = err?.name ?? 'Error';
  return clean;
}

// Llena un campo y confirma que el valor quedó, reintentando si el JS del
// portal lo pisó. Limpia antes de escribir para no concatenar sobre lo que el
// signon haya dejado en el campo durante su inicialización.
async function fillVerified(page, selector, value, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      await page.locator(selector).click();
      await page.fill(selector, '');
      await page.fill(selector, value);
    } catch (err) {
      throw rethrowWithoutSecret(err, value);
    }
    if ((await page.inputValue(selector)) === value) return;
    await page.waitForTimeout(400);
  }
  throw new Error(`No se pudo llenar ${selector} de forma estable en el signon`);
}

// Loguea las credenciales del único operador en un context NUEVO del browser.
// Si el login falla, el context se cierra acá mismo: no quedan contexts
// huérfanos a medio loguear.
export async function loginContext(browser, { username, password }) {
  if (!username || !password) {
    throw new Error('No hay cuenta configurada: seteala en Ajustes o en el .env');
  }

  // Un reintento, y solo si el fallo pasó ANTES de mandar el formulario: en esa
  // fase no hubo intento contra PeopleSoft, así que repetir no acerca el
  // bloqueo por intentos fallidos. Existe porque en una máquina cargada el
  // renderer se queda sin recursos y el campo de contraseña nunca llega a estar
  // editable, que no es un problema de la credencial.
  let last;
  for (let intento = 0; intento < 2; intento += 1) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await doSignon(page, { username, password });
      return { context, page };
    } catch (err) {
      await context.close().catch(() => {});
      last = err;
      if (!err.beforeSubmit) throw err;
    }
  }
  throw last;
}

// Flujo para recon local: la credencial se entrega explícitamente desde un
// caller interactivo; no se lee de .env ni de un archivo en claro.
export async function loginToPeopleSoft({ headless = true, username, password } = {}) {
  const browser = await chromium.launch({ headless, ...(await browserLaunchOptions()) });
  try {
    const { context, page } = await loginContext(browser, { username, password });
    return { browser, context, page };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

async function doSignon(page, credentials) {
  try {
    await signon(page, credentials);
  } catch (err) {
    // Última red: cualquier error de esta rama pasa por el saneo antes de
    // existir aguas arriba, venga de Playwright o de donde venga.
    throw rethrowWithoutSecret(err, credentials?.password);
  }
}

async function signon(page, { username, password }) {
  await page.goto(SIGNON_URL, { waitUntil: 'domcontentloaded' });

  // El signon corre JS de inicialización al cargar que pisa los campos si se
  // llenan demasiado pronto: el userid queda concatenado con basura y el pwd
  // vacío, y el portal rechaza el submit con "User ID and Password are
  // required". Esperamos a que los campos estén visibles y verificamos el
  // valor tras llenar, reintentando si el portal lo alteró.
  try {
    await page.waitForSelector('#userid', { state: 'visible' });
    await page.waitForSelector('#pwd', { state: 'visible' });
    await fillVerified(page, '#userid', username);
    await fillVerified(page, '#pwd', password);
  } catch (err) {
    // Todavía no se mandó nada al portal: el reintento es gratis.
    err.beforeSubmit = true;
    throw err;
  }
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
    // La captura tiene PII del portal: va a app-data/diagnostics con permisos
    // propios, nunca al CWD desde donde se lanzó el agente.
    const shot = await captureFailure(page, 'login-timeout');
    if (loginError && loginError.trim().length > 0) {
      // El portal contestó: la credencial es mala (o la cuenta está bloqueada).
      // Distinguirlo de un timeout importa aguas arriba: esto NO se reintenta.
      const err = new Error(`Login falló: ${loginError.trim()}`);
      err.credentialRejected = true;
      throw err;
    }
    throw new Error(
      `Timeout esperando redirección post-login.${shot ? ` Diagnóstico local: ${shot}` : ''}`
    );
  }
}
