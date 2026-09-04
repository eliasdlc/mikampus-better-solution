#!/usr/bin/env node
// npm is deliberately a foreground entrypoint: `npx mikampus` ends when the
// terminal ends.  A durable agent is an explicit opt-in through install-service.
//
// El entrypoint elige la fuente antes de importar nada. En el paquete npm solo
// existe `dist/app`, que es el bundle publicado. En un checkout existen los dos,
// y `dist/app` es lo que dejó el último `build-production` local: puede tener
// semanas. Preferir `src` ahí evita el modo de fallar más caro que tuvo esto,
// que fue correr código viejo creyendo que se corría el nuevo, sin ninguna
// señal de que fuera así.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = new URL('../src/launcher.js', import.meta.url);
const bundle = new URL('../dist/app/launcher.js', import.meta.url);
const entry = existsSync(fileURLToPath(source)) ? source : bundle;

await import(entry.href);
