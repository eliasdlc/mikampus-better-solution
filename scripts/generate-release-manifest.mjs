import crypto from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map(process.argv.slice(2).flatMap((value, index, values) => value.startsWith('--') ? [[value.slice(2), values[index + 1]]] : []));
const releaseDir = path.resolve(root, args.get('release-dir') || 'release');
const output = path.resolve(root, args.get('output') || 'landing/public/releases/latest.json');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const sha256 = (file) => crypto.createHash('sha256').update(readFileSync(file)).digest('hex');

const archives = (await readdir(releaseDir)).filter((file) => file.startsWith(`mikampus-v${version}-`) && file.endsWith('.tar.gz')).sort();
if (!archives.length) throw new Error(`No hay artefactos de mikampus v${version} en ${releaseDir}.`);

const artifacts = await Promise.all(archives.map(async (filename) => {
  const match = filename.match(/^mikampus-v.+-(.+)-(.+)\.tar\.gz$/);
  if (!match) throw new Error(`Nombre de artefacto inválido: ${filename}`);
  const file = path.join(releaseDir, filename);
  return {
    filename,
    os: match[1],
    architecture: match[2],
    sha256: sha256(file),
    bytes: (await stat(file)).size,
    url: `https://github.com/eliasdlc/mikampus-better-solution/releases/download/v${version}/${filename}`,
    requirements: match[1] === 'linux' && match[2] === 'x64'
      ? 'Ubuntu 24.04 o Debian 12 x64. El binario no está firmado; verifica SHA-256 y procedencia.'
      : 'Consulta las notas del release antes de instalar.',
  };
}));

const manifest = {
  schemaVersion: 1,
  status: 'published',
  generatedAt: new Date().toISOString(),
  version,
  releaseNotesUrl: `https://github.com/eliasdlc/mikampus-better-solution/releases/tag/v${version}`,
  artifacts,
  npm: { package: 'mikampus', command: 'npx mikampus', node: '>=24', foreground: true },
};
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Manifest de release generado: ${output}`);
