// La contraseña del portal no sale en un mensaje de error, y un fallo que
// ocurre ANTES de mandar el formulario no gasta un intento contra la cuenta.
//
// Playwright pone el valor dentro del error de `fill()`: literalmente
// `fill("<la contraseña>")`. Ese mensaje sube por verifyPortalCredentials hasta
// la respuesta del login y se pinta en rojo en la pantalla, así que sin saneo
// la contraseña aparece en claro en la interfaz y en cualquier captura que
// alguien mande. Pasó una vez; esta prueba existe para que no vuelva a pasar.
import assert from 'node:assert/strict';
import { loginContext, scrubSecret } from '../src/login.js';

const CLAVE = 'una-clave-de-prueba';

assert.equal(scrubSecret(`fill("${CLAVE}") - attempting`, CLAVE), 'fill("[contraseña oculta]") - attempting');
assert.equal(scrubSecret('sin secreto adentro', CLAVE), 'sin secreto adentro');
assert.equal(scrubSecret('sin secreto que tapar', null), 'sin secreto que tapar', 'sin secreto no rompe');

/**
 * Un browser de mentira que se porta como el real en las dos formas que
 * importan: `fill` falla con el valor adentro del mensaje, y el portal puede
 * contestar que la credencial no sirve.
 *
 * `fallaLlenadoHasta` es en cuántos contexts falla el llenado antes de andar.
 */
function browserFalso({ fallaLlenadoHasta = 0, rechazaCredencial = false } = {}) {
  const contextos = { creados: 0 };
  const valores = new Map();
  const page = {
    goto: async () => {},
    waitForSelector: async () => {},
    locator: () => ({
      click: async () => {},
      textContent: async () => (rechazaCredencial ? 'Su usuario o contraseña es incorrecta' : ''),
    }),
    fill: async (selector, value) => {
      if (selector === '#pwd' && value !== '' && contextos.creados <= fallaLlenadoHasta) {
        throw new Error(
          `page.fill: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator('#pwd')\n  - fill("${value}")\n  - attempting fill action`
        );
      }
      valores.set(selector, value);
    },
    inputValue: async (selector) => valores.get(selector) ?? '',
    click: async () => {},
    waitForURL: async () => {
      if (rechazaCredencial) throw new Error('sin redirección');
    },
    waitForTimeout: async () => {},
  };
  return {
    contextos,
    newContext: async () => {
      contextos.creados += 1;
      return { newPage: async () => page, close: async () => {} };
    },
  };
}

// ── El error que llega a la pantalla no lleva la contraseña ──
await assert.rejects(
  () => loginContext(browserFalso({ fallaLlenadoHasta: Infinity }), { username: 'exdj0002', password: CLAVE }),
  (error) => {
    assert.ok(!error.message.includes(CLAVE), `la contraseña salió en el error: ${error.message}`);
    assert.match(error.message, /contraseña oculta/, 'y en su lugar queda dicho que se tapó algo');
    assert.match(error.message, /Timeout/, 'el resto del diagnóstico sigue sirviendo');
    return true;
  }
);

// ── Un fallo antes del submit se reintenta: no hubo intento que gastar ──
// En una máquina cargada el renderer se queda sin recursos y el campo de
// contraseña nunca llega a estar editable. Eso no es un problema de la
// credencial y no tiene por qué costarle un login al estudiante.
{
  const browser = browserFalso({ fallaLlenadoHasta: 1 });
  const sesion = await loginContext(browser, { username: 'exdj0002', password: CLAVE });
  assert.ok(sesion.page, 'el segundo intento entró');
  assert.equal(browser.contextos.creados, 2, 'con un context nuevo, no reusando el que quedó a medias');
}

// ── Un rechazo del portal NO se reintenta ──
// Ahí sí hubo intento contra PeopleSoft, y el segundo acerca el bloqueo de la
// cuenta por intentos fallidos.
{
  const browser = browserFalso({ rechazaCredencial: true });
  await assert.rejects(
    () => loginContext(browser, { username: 'exdj0002', password: CLAVE }),
    (error) => {
      assert.equal(error.credentialRejected, true, 'el portal contestó que la credencial no sirve');
      assert.ok(!error.message.includes(CLAVE));
      return true;
    }
  );
  assert.equal(browser.contextos.creados, 1, 'un rechazo no gasta un intento extra');
}

console.log('✓ login: la contraseña nunca sale en el error, y un fallo previo al submit reintenta sin gastar intentos contra el portal');
