import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const name = `mikampus-v${pkg.version}-linux-x64`;
const release = path.join(root, 'release');
const archive = path.join(release, `${name}.tar.gz`);
function run(command, args, { input, ...options } = {}) { return new Promise((resolve, reject) => { const child = spawn(command, args, { stdio: 'pipe', ...options }); let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; }); child.once('error', reject); if (input) child.stdin.end(input); else child.stdin.end(); child.once('exit', (code) => code === 0 ? resolve(output) : reject(new Error(`${command} termin\u00f3 con ${code}: ${output}`))); }); }

if (!fs.existsSync(archive)) await run(process.execPath, [path.join(root, 'scripts', 'build-distribution.mjs')], { cwd: root });
const list = await run('tar', ['-tzf', archive]);
for (const file of ['install.sh', 'uninstall.sh', 'payload/node', 'payload/app/launcher.js', 'SBOM.json', 'provenance.json', 'THIRD_PARTY_NOTICES']) assert.match(list, new RegExp(`${name}/${file.replace('.', '\\.')}`), `incluye ${file}`);
assert.ok(fs.existsSync(path.join(release, 'SHA256SUMS')), 'publica SHA256SUMS');
assert.match(await readFile(path.join(release, 'SHA256SUMS'), 'utf8'), new RegExp(`${name}\\.tar\\.gz`), 'el checksum cubre el archivo instalable');
const home = await mkdtemp(path.join(tmpdir(), 'mikampus-dist-home-'));
const extract = await mkdtemp(path.join(tmpdir(), 'mikampus-dist-extract-'));
try {
  await run('tar', ['-xzf', archive, '-C', extract]);
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, 'data'), MIKAMPUS_INSTALL_ROOT: path.join(home, 'app'), MIKAMPUS_BIN_DIR: path.join(home, 'bin'), MIKAMPUS_SKIP_SERVICE: '1' };
  await run('sh', [path.join(extract, name, 'install.sh'), '--no-service'], { env });
  const binary = path.join(home, 'bin', 'mikampus');
  assert.ok(fs.existsSync(binary), 'instala el launcher de usuario');
  const version = await run(binary, ['version'], { env });
  assert.match(version, new RegExp(pkg.version), 'el launcher ejecuta el core instalado');
  const started = await run(binary, ['start'], { env: { ...env, PORT: '47194', MIKAMPUS_SILENT: '1' } });
  assert.match(started, /iniciado/, 'el core instalado inicia su agente');
  const status = await run(binary, ['status'], { env: { ...env, PORT: '47194', MIKAMPUS_SILENT: '1' } });
  assert.match(status, /"running": true/, 'el agente instalado responde por healthcheck');
  await run(binary, ['stop'], { env: { ...env, PORT: '47194', MIKAMPUS_SILENT: '1' } });
  const sentinel = path.join(home, 'data', 'preserve-me');
  fs.writeFileSync(sentinel, 'datos locales');
  await run('sh', [path.join(extract, name, 'install.sh'), '--no-service'], { env });
  assert.ok(fs.existsSync(sentinel), 'un upgrade conserva los datos locales');
  await run('sh', [path.join(extract, name, 'uninstall.sh')], { env, input: 'n\n' });
  assert.ok(!fs.existsSync(binary), 'uninstall retira el launcher');
  assert.ok(!fs.existsSync(path.join(home, 'app')), 'uninstall retira el core');
} finally { await rm(home, { recursive: true, force: true }); await rm(extract, { recursive: true, force: true }); }
console.log('✓ distribución Linux: archive, checksum, first-run, stop/start, upgrade y uninstall con preservación');
