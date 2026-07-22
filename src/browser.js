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

// ¿Ya hay un browser usable? Playwright es el dueño de la respuesta: sabe qué
// build necesita esta versión y dónde la deja. Preguntarle evita inventar una
// heurística de carpetas que se desincroniza en cada upgrade.
export async function browserStatus() {
  const { browsers } = dataPaths();
  try {
    const { chromium } = await import('playwright');
    const executable = chromium.executablePath();
    return { installed: fs.existsSync(executable), executable, root: browsers };
  } catch (error) {
    return { installed: false, executable: null, root: browsers, error: error.message };
  }
}

// Playwright reporta el avance como "|████ | 45% of 160.5 MiB". La UI no
// muestra esa línea cruda: se le pasa el porcentaje para una barra real.
export function parseProgress(line) {
  const percent = String(line).match(/(\d{1,3})%/);
  if (!percent) return null;
  const value = Number(percent[1]);
  return value >= 0 && value <= 100 ? value : null;
}

// Playwright owns browser compatibility and its cache layout. We only give it
// a private app-data root, surface its progress, and retry a transient failed
// download once. SIGINT/SIGTERM are forwarded so cancellation never leaves the
// agent running in the background.
export async function installBrowser({ attempts = 2, onProgress = null, onLog = null } = {}) {
  const { browsers } = dataPaths();
  fs.mkdirSync(browsers, { recursive: true, mode: 0o700 });
  // Sin callbacks el proceso hereda la consola (uso por CLI); con callbacks se
  // captura la salida para que la UI muestre la misma descarga sin terminal.
  const streaming = Boolean(onProgress || onLog);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const [command, args] = browserInstallCommand();
    const header = `Descargando browser administrado (${attempt}/${attempts})…`;
    if (onLog) onLog(header);
    else console.log(header);
    const code = await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: streaming ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        env: process.env,
      });
      if (streaming) {
        const consume = (chunk) => {
          for (const line of String(chunk).split(/\r?\n|\r/)) {
            const text = line.trim();
            if (!text) continue;
            const percent = parseProgress(text);
            if (percent != null) onProgress?.(percent, text);
            else onLog?.(text);
          }
        };
        child.stdout.on('data', consume);
        child.stderr.on('data', consume);
      }
      const forward = (signal) => child.kill(signal);
      process.once('SIGINT', forward); process.once('SIGTERM', forward);
      child.once('error', reject);
      child.once('exit', (exitCode) => {
        process.removeListener('SIGINT', forward); process.removeListener('SIGTERM', forward);
        resolve(exitCode);
      });
    });
    if (code === 0) {
      onProgress?.(100, 'listo');
      return browsers;
    }
    lastError = new Error(`Playwright terminó con código ${code}`);
  }
  throw lastError;
}
