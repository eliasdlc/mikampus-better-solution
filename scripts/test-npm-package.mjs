import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(path.join(root, 'dist', 'app', 'launcher.js'))) throw new Error('Primero ejecutá npm run build:production');
function exec(command, args, options = {}) { return new Promise((resolve, reject) => execFile(command, args, options, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout))); }
const output = await exec('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: root });
const packed = JSON.parse(output)[0];
const files = packed.files.map(({ path: file }) => file);
for (const required of ['bin/mikampus.mjs', 'dist/app/launcher.js', 'dist/public/dist/index.html', 'LICENSE', 'THIRD_PARTY_NOTICES', 'README.md']) assert.ok(files.includes(required), `npm tarball contiene ${required}`);
for (const forbidden of ['fixtures/', 'scripts/', 'src/', 'web/']) assert.ok(!files.some((file) => file.startsWith(forbidden)), `npm tarball excluye ${forbidden}`);
assert.equal(packed.name, 'mikampus-better-solution', 'el candidato conserva el nombre privado hasta resolver P2');
const temp = await mkdtemp(path.join(tmpdir(), 'mikampus-npm-package-'));
try {
  const packageOutput = await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { cwd: root });
  const tarball = path.join(temp, JSON.parse(packageOutput)[0].filename);
  await exec('npm', ['install', '--ignore-scripts', tarball], { cwd: temp });
  const port = '47195';
  const child = spawn('npx', ['--no-install', 'mikampus'], { cwd: temp, env: { ...process.env, PORT: port, MIKAMPUS_DATA_DIR: path.join(temp, 'data'), MIKAMPUS_SILENT: '1' }, stdio: 'ignore' });
  try {
    const deadline = Date.now() + 10_000;
    let ready = false;
    while (Date.now() < deadline) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/`)).ok; } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'npx ejecuta el tarball instalado en foreground');
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode == null) await new Promise((resolve) => child.once('exit', resolve));
  }
} finally { await rm(temp, { recursive: true, force: true }); }
console.log(`✓ npm candidate: ${packed.files.length} archivos, runtime y avisos incluidos, sin source ni fixtures; npx smoke verde`);
