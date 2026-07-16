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
export function withPage(fn) {
  const run = async () => {
    await ensureSession();
    try {
      return await fn(page);
    } catch (err) {
      await teardown();
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

export async function shutdown() {
  await teardown();
}
