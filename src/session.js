import { loginToPeopleSoft } from './login.js';

let browser = null;
let page = null;
let queue = Promise.resolve();

async function ensureSession() {
  if (page && !page.isClosed() && !page.url().includes('cmd=login')) {
    return;
  }
  await teardown();
  const session = await loginToPeopleSoft({ headless: true });
  browser = session.browser;
  page = session.page;
}

async function teardown() {
  try {
    await browser?.close();
  } catch {
    // el browser ya podía estar muerto, no importa
  }
  browser = null;
  page = null;
}

// Todas las acciones contra PeopleSoft pasan por acá: una sola sesión
// compartida entre el watcher, la hora programada y los clicks manuales del
// usuario, en fila (nunca dos acciones de Playwright en paralelo sobre la
// misma página) y con un reintento automático si la sesión expiró a mitad
// de camino.
export function withPage(fn, { retry = true } = {}) {
  const run = async () => {
    await ensureSession();
    try {
      return await fn(page);
    } catch (err) {
      await teardown();
      // Una operación con efectos (enroll/drop) no se repite a ciegas: el
      // timeout pudo ocurrir DESPUÉS del submit. El caller debe verificar el
      // estado antes de decidir un segundo intento.
      if (!retry) throw err;
      await ensureSession();
      return await fn(page);
    }
  };
  const result = queue.then(run, run);
  queue = result.then(
    () => {},
    () => {}
  );
  return result;
}

// Fuerza que la próxima acción re-loguee desde cero. Se usa al cambiar de
// cuenta: sin esto, ensureSession() reusaría el navegador logueado con la
// cuenta vieja (solo re-loguea si la página cayó en cmd=login). Va por la
// misma fila que withPage para no matar el navegador a mitad de un scrape.
export function resetSession() {
  const run = () => teardown();
  const result = queue.then(run, run);
  queue = result.then(
    () => {},
    () => {}
  );
  return result;
}

export async function shutdown() {
  await teardown();
}
