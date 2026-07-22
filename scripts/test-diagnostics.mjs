// Diagnósticos: dentro de app-data, redactados, con retención propia y sin
// salida implícita. Una captura del portal solo sale si el usuario la exporta.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-diag-'));
process.env.MIKAMPUS_DATA_DIR = dir;
process.env.MIKAMPUS_DIAGNOSTICS_KEEP = '3';

const diagnostics = await import('../src/diagnostics.js');

try {
  assert.ok(diagnostics.diagnosticsDir.startsWith(dir), 'los diagnósticos viven bajo app-data, nunca en el CWD');

  // Redacción de lo que la política de fixtures prohíbe versionar.
  const crudo = [
    'GET /psp/cs92pro?ICSID=abc123&ICStateNum=7',
    'password: supersecreta',
    'Cookie: PS_TOKEN=xyz',
    '{"EMPLID":"1092-4471"}',
  ].join('\n');
  const limpio = diagnostics.redact(crudo);
  for (const secreto of ['abc123', 'supersecreta', 'PS_TOKEN=xyz', '1092-4471']) {
    assert.ok(!limpio.includes(secreto), `redacta ${secreto}`);
  }

  const file = diagnostics.writeDiagnostic('timeout', crudo, { now: new Date('2026-07-20T10:00:00Z') });
  assert.ok(fs.existsSync(file));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'el archivo no es legible por otros usuarios');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('supersecreta'), 'lo escrito ya está redactado');

  // Retención: un diagnóstico viejo no ayuda y alarga la vida de la PII.
  for (let i = 0; i < 5; i += 1) {
    diagnostics.writeDiagnostic(`extra-${i}`, 'ok', { now: new Date(Date.parse('2026-07-20T11:00:00Z') + i * 1000) });
  }
  assert.equal(diagnostics.listDiagnostics().length, 3, 'la retención poda los diagnósticos viejos');

  // Exportar es explícito, marca cuáles son capturas y no mueve nada.
  fs.writeFileSync(path.join(diagnostics.diagnosticsDir, 'captura.png'), 'binario');
  assert.ok(diagnostics.listDiagnostics().some((entry) => entry.pii), 'una captura se marca como PII');
  const destino = path.join(dir, 'salida');
  const exported = diagnostics.exportDiagnostics(destino);
  assert.equal(exported.files.length, diagnostics.listDiagnostics().length, 'exporta lo que hay');
  assert.ok(fs.existsSync(path.join(destino, 'captura.png')));
  assert.ok(fs.existsSync(diagnostics.diagnosticsDir), 'exportar copia, no vacía la carpeta');
  assert.throws(() => diagnostics.exportDiagnostics(), /carpeta/, 'sin destino elegido no hay exportación');

  // Se pueden apagar del todo.
  assert.equal(diagnostics.diagnosticsEnabled({ MIKAMPUS_DIAGNOSTICS: 'off' }), false);
  assert.equal(diagnostics.diagnosticsEnabled({}), true);

  diagnostics.clearDiagnostics();
  assert.equal(diagnostics.listDiagnostics().length, 0);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('✓ diagnósticos: en app-data, redactados, con retención y salida solo explícita');
