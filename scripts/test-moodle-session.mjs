// El token de la PVA como credencial: dónde vive, cuándo se saca, cuándo se
// tira, y la regla que atraviesa todo el archivo: que una fuente rechace su
// contraseña no puede tumbar la otra.
//
// Sin red: el fetch es de mentira y cuenta cuántas veces se pidió token.
import { mkdtemp, rm, readFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-pva-'));
process.env.MIKAMPUS_DATA_DIR = dir;
process.env.MIKAMPUS_CREDENTIALS_FILE = path.join(dir, 'credenciales.env');
process.env.PVA_URL = 'https://campusvirtual.pucmm.edu.do/moodle';

const {
  writeCredential,
  readCredential,
  deleteCredential,
  readPvaToken,
  readPvaCredential,
  writePvaToken,
} = await import('../src/credentialStore.js');
const { linkPvaCredential, callPva, hasPvaCredential, hasPvaToken, forgetPvaSession } = await import(
  '../src/moodle/session.js'
);

const file = process.env.MIKAMPUS_CREDENTIALS_FILE;
const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

// Un sitio de mentira: contesta token.php con el token que se le diga y
// server.php con lo que devuelva `ws`. Cuenta las dos cosas por separado.
function site({ token = 'token-1', tokenError = null, ws = () => ({ ok: true }) } = {}) {
  const counts = { token: 0, ws: 0 };
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/login/token.php')) {
      counts.token += 1;
      return json(tokenError ? { error: 'Datos erróneos', errorcode: tokenError } : { token });
    }
    counts.ws += 1;
    const body = new URLSearchParams(init.body);
    return json(ws(body, counts.ws));
  };
  return { fetchImpl, counts };
}

try {
  // El portal ya está adentro: es lo que la PVA nunca puede tumbar.
  writeCredential({ username: 'ab123456', password: 'clave-del-portal' });

  // ── Sin contraseña de la PVA no hay llamada que valga ──
  assert.equal(hasPvaCredential(), false, 'entrar a micampus no vincula la PVA');
  {
    const { fetchImpl, counts } = site();
    const err = await callPva('core_webservice_get_site_info', {}, { fetchImpl }).catch((e) => e);
    assert.equal(err.needsCredentials, true, 'pide vincular, no revienta con un error genérico');
    assert.deepEqual(counts, { token: 0, ws: 0 }, 'y no molesta al servidor para averiguarlo');
  }

  // ── Una vinculación rechazada no deja peor lo que había ──
  {
    const { fetchImpl } = site({ tokenError: 'invalidlogin' });
    const err = await linkPvaCredential({ username: 'ab123456', password: 'mala' }, { fetchImpl }).catch((e) => e);
    assert.equal(err.credentialRejected, true, 'la PVA dijo que no');
    assert.equal(readPvaCredential(), null, 'no se guarda una contraseña que el sitio rechazó');
    assert.deepEqual(readCredential(), { username: 'ab123456', password: 'clave-del-portal' }, 'y el portal sigue vivo');
  }

  // ── Vincular: la contraseña y el token viven en el archivo, modo 600 ──
  {
    const { fetchImpl, counts } = site({ token: 'token-1' });
    await linkPvaCredential({ username: 'ab123456', password: 'clave-de-la-pva' }, { fetchImpl });
    assert.equal(counts.token, 1);
    assert.deepEqual(readPvaCredential(), { username: 'ab123456', password: 'clave-de-la-pva' }, 'el usuario es el mismo del portal');
    assert.equal(readPvaToken(), 'token-1');
    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o777, 0o600, 'solo el dueño puede leer el token');
    }
    // Nunca en la base ni en un backup: el único archivo del data dir que lo
    // contiene es el de credenciales.
    const withToken = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const text = await readFile(path.join(dir, entry.name), 'utf8').catch(() => '');
      if (text.includes('token-1')) withToken.push(entry.name);
    }
    assert.deepEqual(withToken, ['credenciales.env'], 'el token no se copia a ningún otro archivo del data dir');
  }

  // ── Con token guardado no se vuelve a pedir uno ──
  {
    const { fetchImpl, counts } = site({ ws: (body) => ({ visto: body.get('wstoken') }) });
    const data = await callPva('core_enrol_get_users_courses', { userid: 90001 }, { fetchImpl });
    assert.equal(data.visto, 'token-1', 'usa el guardado');
    assert.deepEqual(counts, { token: 0, ws: 1 }, 'sin pasar por token.php');
  }

  // ── El token murió: se tira, se saca otro y la llamada se rehace una vez ──
  {
    const { fetchImpl, counts } = site({
      token: 'token-2',
      ws: (body, n) => (n === 1 ? { errorcode: 'invalidtoken' } : { visto: body.get('wstoken') }),
    });
    const data = await callPva('core_enrol_get_users_courses', {}, { fetchImpl });
    assert.equal(data.visto, 'token-2', 'la segunda va con el token nuevo');
    assert.deepEqual(counts, { token: 1, ws: 2 }, 'un solo re-login, un solo reintento');
    assert.equal(readPvaToken(), 'token-2', 'y el nuevo queda guardado');
  }

  // ── El token murió porque cambió la contraseña de la PVA ──
  {
    const { fetchImpl } = site({ tokenError: 'invalidlogin', ws: () => ({ errorcode: 'invalidtoken' }) });
    const err = await callPva('core_enrol_get_users_courses', {}, { fetchImpl }).catch((e) => e);
    assert.equal(err.credentialRejected, true, 'el sitio rechazó la contraseña guardada');
    assert.equal(hasPvaCredential(), false, 'que se vacía: dejarla ahí solo sirve para volver a fallar');
    assert.equal(hasPvaToken(), false, 'y el token muerto se va con ella');
    assert.deepEqual(
      readCredential(),
      { username: 'ab123456', password: 'clave-del-portal' },
      'micampus no se entera: una fuente caída no tumba la otra'
    );
  }

  // ── Dos ramas que arrancan juntas piden un solo token ──
  {
    writePvaToken('token-viejo');
    forgetPvaSession();
    const { fetchImpl, counts } = site({ token: 'token-3', ws: (body) => ({ visto: body.get('wstoken') }) });
    await linkPvaCredential({ username: 'ab123456', password: 'clave-de-la-pva' }, { fetchImpl });
    const { forgetPvaToken } = await import('../src/credentialStore.js');
    forgetPvaToken();
    const [a, b] = await Promise.all([
      callPva('core_enrol_get_users_courses', {}, { fetchImpl }),
      callPva('core_webservice_get_site_info', {}, { fetchImpl }),
    ]);
    assert.equal(a.visto, 'token-3');
    assert.equal(b.visto, 'token-3');
    assert.equal(counts.token, 2, 'uno de vincular y uno solo para las dos llamadas en paralelo');
  }

  // ── Cerrar la PVA no cierra el portal, y al revés tampoco ──
  {
    forgetPvaSession();
    assert.equal(hasPvaCredential(), false);
    assert.equal(hasPvaToken(), false);
    assert.deepEqual(readCredential(), { username: 'ab123456', password: 'clave-del-portal' });

    const { fetchImpl } = site({ token: 'token-4' });
    await linkPvaCredential({ username: 'ab123456', password: 'clave-de-la-pva' }, { fetchImpl });
    deleteCredential();
    assert.equal(readCredential(), null, 'el portal rechazó su contraseña y se vació');
    assert.equal(readPvaToken(), 'token-4', 'la PVA sigue vinculada: son dos credenciales, no una');
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ sesión de la PVA: el token vive con la contraseña, se renueva solo una vez y ninguna fuente tumba a la otra');
