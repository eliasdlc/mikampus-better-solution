// La privacidad del servidor MCP no es disciplina, son cierres verificables.
// Este test comprueba los tres: qué módulos puede alcanzar el carril de lectura,
// que su conexión no pueda escribir, y que la allowlist deje afuera lo sensible.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 1. Grafo de imports estáticos ──────────────────────────────────────────
// Un import estático es una dependencia que el proceso carga sí o sí. Si el
// carril de lectura pudiera alcanzar el vault o la conexión de escritura, el
// aislamiento sería una promesa del README y no una propiedad del código.

const STATIC_IMPORT = /^\s*import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/gm;

async function staticGraph(entry) {
  const seen = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let source;
    try {
      source = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of source.matchAll(STATIC_IMPORT)) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      pending.push(path.resolve(path.dirname(file), specifier));
    }
  }
  return seen;
}

const readGraph = await staticGraph(path.join(root, 'src', 'mcp', 'server.js'));
const relative = [...readGraph].map((file) => path.relative(root, file)).sort();

const FORBIDDEN = [
  'src/credentialStore.js',
  'src/session.js',
  'src/browser.js',
  'src/login.js',
  'src/webpush.js',
  'src/auth.js',
  'src/users.js',
  'src/scheduler.js',
  // db.js es la conexión de ESCRITURA del agente y corre migraciones al
  // importarse: el carril de lectura abre el archivo por su cuenta.
  'src/db.js',
];
for (const forbidden of FORBIDDEN) {
  assert.ok(!relative.includes(forbidden), `el carril de lectura no alcanza ${forbidden} (alcanza: ${relative.join(', ')})`);
}

// El carril de acción se importa dinámicamente y solo cuando está encendido:
// sin esa condición el proceso abriría una conexión de escritura siempre.
const serverSource = await readFile(path.join(root, 'src', 'mcp', 'server.js'), 'utf8');
assert.ok(!/^\s*import\s.*['"]\.\/actions\.js['"]/m.test(serverSource), 'actions.js no se importa estáticamente');
assert.ok(/await import\('\.\/actions\.js'\)/.test(serverSource), 'actions.js entra por import dinámico');

// ── 2. La conexión no puede escribir ───────────────────────────────────────
const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-mcp-isolation-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_DATA_DIR = dir;

try {
  const { db } = await import('../src/db.js');
  db.exec("INSERT OR IGNORE INTO users (id) VALUES (1)");

  const mcpDb = await import('../src/mcp/db.js');
  assert.equal(mcpDb.readRows('SELECT u.id FROM users u', [], { u: 'users' }).length, 1, 'la lectura funciona');
  assert.throws(() => mcpDb.attemptWrite(), /readonly|read-only|authorization/i, 'la conexión del MCP rechaza escribir');

  // ── 3. La allowlist ─────────────────────────────────────────────────────
  const { READ_ALLOWLIST, assertReadable } = await import('../src/mcp/allowlist.js');
  for (const table of ['sessions', 'push_subscriptions', 'notifications', 'notification_channels']) {
    assert.ok(!(table in READ_ALLOWLIST), `${table} está fuera de la allowlist`);
  }
  assert.ok(!READ_ALLOWLIST.users.includes('portal_username'), 'el username del portal no se expone');

  assert.throws(
    () => assertReadable('SELECT s.token_hash FROM sessions s', { s: 'sessions' }),
    /no se expone|allowlist/,
    'una consulta sobre sessions se rechaza'
  );
  assert.throws(() => assertReadable('SELECT * FROM courses c', { c: 'courses' }), /SELECT \*/, 'SELECT * se rechaza');
  assert.throws(
    () => assertReadable('DELETE FROM courses'),
    /no ejecuta sentencias que escriban/,
    'una sentencia de escritura se rechaza'
  );
  assert.throws(
    () => assertReadable('SELECT ps.endpoint FROM push_subscriptions ps', { ps: 'push_subscriptions' }),
    /no se expone/,
    'las claves de push se rechazan'
  );

  // ── 4. La denylist de claves sobre la respuesta ─────────────────────────
  const { sanitize } = await import('../src/mcp/redact.js');
  const cleaned = sanitize({
    ok: true,
    active: true,
    csrfToken: 'x',
    session: { token_hash: 'y', p256dh: 'z' },
    detail: 'EMPLID: 99999',
  });
  assert.deepEqual(Object.keys(cleaned).sort(), ['active', 'detail', 'ok', 'session']);
  assert.deepEqual(cleaned.session, {}, 'las claves sensibles anidadas también se van');
  assert.ok(!cleaned.detail.includes('99999'), 'el texto libre pasa por la redacción');
  assert.equal(cleaned.active, true, 'una clave legítima que contiene "iv" sobrevive');
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ MCP aislado: sin vault ni conexión de escritura, allowlist cerrada y respuestas saneadas');
