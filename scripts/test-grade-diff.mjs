import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-grade-diff-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
const { diffPublishedGrades } = await import('../src/peoplesoft/grades.js');

const base = [
  { term: 'Abril de 2026', code: 'ICC-303', grade: null, title: 'Estructuras' },
  { term: 'Abril de 2026', code: 'MAT-241', grade: 'B', title: 'Cálculo' },
];
assert.deepEqual(diffPublishedGrades([], [{ ...base[0], grade: 'A' }]), [], 'el primer sync no inunda notificaciones');
assert.deepEqual(
  diffPublishedGrades(base, [{ ...base[0], grade: 'A' }, base[1]]).map((course) => course.code),
  ['ICC-303'],
  'null → nota publicada notifica'
);
assert.deepEqual(diffPublishedGrades(base, base), [], 'sin cambio no notifica');
assert.deepEqual(diffPublishedGrades(base, [{ ...base[1], grade: 'A' }]), [], 'una corrección B→A no se anuncia como nota nueva');

await rm(dir, { recursive: true, force: true });
console.log('✓ diff de notas nuevas (sin flood inicial ni duplicados)');
