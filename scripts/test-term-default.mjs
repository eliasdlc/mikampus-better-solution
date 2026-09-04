import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-term-default-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
const { db } = await import('../src/db.js');
const { planningTerm } = await import('../src/terms.js');
db.exec(`
  INSERT INTO terms (code, label, start_date, end_date) VALUES
    ('1920', 'Abril de 2026', '2026-05-01', '2026-08-31'),
    ('1930', 'Septiembre de 2026', '2026-09-01', '2026-12-07');
`);

// El mismo día fijo que usa test-terms-db: en julio de 2026, 1930 todavía es el
// ciclo siguiente. Sin pasarlo, este test se rompía solo al llegar septiembre.
const hoy = new Date(2026, 6, 17);

assert.equal(planningTerm(null, null, hoy), '1930', 'el default de planificación es nextTerm');
assert.equal(planningTerm('1920', null, hoy), '1920', 'un término pedido explícitamente gana');
process.env.TARGET_TERM = '9999';
assert.equal(planningTerm(null, null, hoy), '1930', 'TARGET_TERM ya no gobierna ningún default');
delete process.env.TARGET_TERM;

await rm(dir, { recursive: true, force: true });
console.log('✓ defaults por nextTerm; TARGET_TERM ausente o presente no cambia la app');
