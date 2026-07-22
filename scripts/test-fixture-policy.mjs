import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';

const manifest = JSON.parse(await readFile('fixtures/manifest.json', 'utf8'));
const fixtureFiles = (await readdir('fixtures')).filter((file) => file.endsWith('.html')).sort();
const reviewedFiles = Object.keys(manifest.fixtures).sort();

assert.equal(manifest.version, 1, 'la política de fixtures tiene una versión conocida');
assert.deepEqual(reviewedFiles, fixtureFiles, 'cada fixture HTML está revisado y no hay entradas obsoletas');

for (const file of fixtureFiles) {
  const description = manifest.fixtures[file];
  assert.ok(description.length >= 24, `${file} documenta el caso de parser que justifica conservarlo`);
  const size = (await stat(`fixtures/${file}`)).size;
  assert.ok(size <= 300 * 1024, `${file} no supera el presupuesto de 300 KiB`);
}

console.log(`✓ política de fixtures: ${fixtureFiles.length} fixtures revisados y dentro de presupuesto`);
