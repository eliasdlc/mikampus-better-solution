import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.env.MIKAMPUS_ARTIFACT_DIR || path.join(root, 'build', `mikampus-${process.platform}-${process.arch}`);
const app = path.join(target, 'app');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} terminó con ${code}`)));
  });
}

await rm(target, { recursive: true, force: true });
await mkdir(app, { recursive: true });
await run(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build']);
await build({
  // Dos entrypoints: el agente y el servidor MCP. El MCP es un proceso aparte
  // que un cliente lanza por stdio, así que no puede colgar del launcher.
  entryPoints: [path.join(root, 'src', 'launcher.js'), path.join(root, 'src', 'mcp', 'stdio.js')],
  outdir: app,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  packages: 'external',
  sourcemap: true,
});
await cp(path.join(root, 'public'), path.join(target, 'public'), { recursive: true });
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES', 'README.md']) await cp(path.join(root, file), path.join(target, file));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await writeFile(path.join(target, 'package.json'), JSON.stringify({
  name: 'mikampus-local-artifact', version: manifest.version, private: true, type: 'module', engines: { node: '>=24' },
  dependencies: manifest.dependencies,
}, null, 2) + '\n');
await run('npm', ['install', '--omit=dev', '--ignore-scripts', '--package-lock=false'], { cwd: target });
console.log(`Artefacto listo: ${target}`);
