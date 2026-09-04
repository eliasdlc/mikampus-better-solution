import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flag = process.argv.indexOf('--manifest');
const manifestPath = flag === -1 ? path.join(root, 'landing/public/releases/latest.json') : path.resolve(root, process.argv[flag + 1]);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.equal(manifest.schemaVersion, 1);
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.ok(['published', 'unpublished'].includes(manifest.status));
assert.ok(Array.isArray(manifest.artifacts));
assert.ok(manifest.status === 'unpublished' || manifest.artifacts.length > 0);
for (const artifact of manifest.artifacts) {
  assert.match(artifact.filename, /^mikampus-v.+\.tar\.gz$/);
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  assert.match(artifact.url, /^https:\/\/github\.com\//);
  assert.ok(artifact.os && artifact.architecture && artifact.requirements);
}
assert.equal(manifest.npm.package, 'mikampus');
assert.equal(manifest.npm.foreground, true);
console.log(`✓ manifest ${manifest.status} v${manifest.version}: ${manifest.artifacts.length} artefacto(s) válido(s)`);
