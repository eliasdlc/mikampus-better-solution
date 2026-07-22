import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dataPaths } from './paths.js';

const require = createRequire(import.meta.url);

export function browserInstallCommand() {
  const playwrightDir = path.dirname(require.resolve('playwright/package.json'));
  return [process.execPath, [path.join(playwrightDir, 'cli.js'), 'install', 'chromium']];
}

// Playwright owns browser compatibility and its cache layout. We only give it
// a private app-data root, surface its progress, and retry a transient failed
// download once. SIGINT/SIGTERM are forwarded so cancellation never leaves the
// agent running in the background.
export async function installBrowser({ attempts = 2 } = {}) {
  const { browsers } = dataPaths();
  fs.mkdirSync(browsers, { recursive: true, mode: 0o700 });
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const [command, args] = browserInstallCommand();
    console.log(`Descargando browser administrado (${attempt}/${attempts})…`);
    const code = await new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: 'inherit', env: process.env });
      const forward = (signal) => child.kill(signal);
      process.once('SIGINT', forward); process.once('SIGTERM', forward);
      child.once('error', reject);
      child.once('exit', (exitCode) => {
        process.removeListener('SIGINT', forward); process.removeListener('SIGTERM', forward);
        resolve(exitCode);
      });
    });
    if (code === 0) return browsers;
    lastError = new Error(`Playwright terminó con código ${code}`);
  }
  throw lastError;
}
