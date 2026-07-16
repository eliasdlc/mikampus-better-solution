// Gate de performance del plan (sección 6): el bundle inicial (JS + CSS de
// entrada, comprimido) no puede pasar de 250KB gz. Las fuentes cargan aparte y
// no cuentan. Falla con exit 1 si se pasa, para poder meterlo en CI.
import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const BUDGET_KB = 250;
const dir = path.join(import.meta.dirname, '..', 'public', 'dist', 'assets');

const files = readdirSync(dir);
const entry = files.filter((f) => /^index-.*\.(js|css)$/.test(f));
if (entry.length === 0) {
  console.error('No se encontró el bundle de entrada. ¿Corriste `npm run build`?');
  process.exit(1);
}

let totalGz = 0;
for (const f of entry) {
  const gz = gzipSync(readFileSync(path.join(dir, f))).length;
  totalGz += gz;
  console.log(`  ${f.padEnd(28)} ${(gz / 1024).toFixed(1)} KB gz`);
}

const kb = totalGz / 1024;
console.log(`\nBundle inicial: ${kb.toFixed(1)} KB gz  /  presupuesto ${BUDGET_KB} KB gz`);
if (kb > BUDGET_KB) {
  console.error(`✗ Excede el presupuesto por ${(kb - BUDGET_KB).toFixed(1)} KB`);
  process.exit(1);
}
console.log('✓ Dentro del presupuesto');
