import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const artifact = process.env.MIKAMPUS_ARTIFACT_DIR || path.join(root, 'build', `mikampus-${process.platform}-${process.arch}`);
assert.ok(existsSync(path.join(artifact, 'app', 'launcher.js')), 'el artifact contiene launcher bundleado');
assert.ok(existsSync(path.join(artifact, 'public', 'dist', 'index.html')), 'el artifact contiene SPA compilada');
assert.ok(existsSync(path.join(artifact, 'LICENSE')), 'el artifact contiene LICENSE');
assert.ok(existsSync(path.join(artifact, 'THIRD_PARTY_NOTICES')), 'el artifact contiene notices');
assert.ok(!existsSync(path.join(artifact, 'fixtures')), 'el artifact no incluye fixtures');
assert.ok(!existsSync(path.join(artifact, 'scripts')), 'el artifact no incluye scripts de recon/tests');

const dataDir = await mkdtemp(path.join(tmpdir(), 'mikampus-package-'));
const port = 47193;
const child = spawn(process.execPath, [path.join(artifact, 'app', 'launcher.js')], {
  cwd: tmpdir(),
  env: { ...process.env, PORT: String(port), MIKAMPUS_DATA_DIR: dataDir, MIKAMPUS_SILENT: '1' },
  stdio: 'ignore',
});
try {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok && (await response.text()).includes('<div id="root">')) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const index = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(index.status, 200, 'el artifact sirve la SPA');
  assert.ok(existsSync(path.join(dataDir, 'mikampus.db')), 'SQLite se crea en app-data');
  assert.ok(!existsSync(path.join(artifact, 'mikampus.db')), 'SQLite no se escribe junto al artifact');
  if (process.env.MIKAMPUS_BROWSER_SMOKE === '1') {
    const requireArtifact = createRequire(path.join(artifact, 'package.json'));
    const { chromium } = requireArtifact('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent('<main data-fixture="synthetic">artifact fixture</main>');
    assert.equal(await page.locator('[data-fixture="synthetic"]').textContent(), 'artifact fixture', 'Playwright del artifact abre fixture sintético');
    await browser.close();
  }
} finally {
  child.kill('SIGTERM');
  if (child.exitCode == null) await new Promise((resolve) => child.once('exit', resolve));
  await rm(dataDir, { recursive: true, force: true });
}
console.log(`✓ artifact: SPA, SQLite app-data, payload mínimo${process.env.MIKAMPUS_BROWSER_SMOKE === '1' ? ' y browser fixture' : ''}`);
