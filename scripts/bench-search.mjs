// Gate de performance (sección 6): keystroke → resultados < 16ms (un frame).
// El catálogo sembrado es diminuto, así que medimos sobre un catálogo sintético
// del tamaño de un término real (~3000 secciones) para validar que el enfoque
// (índice MiniSearch en memoria del cliente) aguanta la escala.
import { performance } from 'node:perf_hooks';
import { buildIndex } from '../web/src/lib/search.ts';

const SUBJECTS = ['ICC', 'MAT', 'FIS', 'QUI', 'ADM', 'DER', 'MED', 'ARQ', 'CIV', 'IND'];
const WORDS = ['Cálculo', 'Estructuras', 'Física', 'Programación', 'Bases', 'Datos', 'Álgebra', 'Redes', 'Sistemas', 'Análisis', 'Diseño', 'Química', 'Estadística', 'Circuitos'];

const courses = [];
let id = 1;
for (let i = 0; i < 3000; i++) {
  const subject = SUBJECTS[i % SUBJECTS.length];
  const nbr = String(100 + (i % 500));
  courses.push({
    id: id++,
    code: `${subject}-${nbr}`,
    subject,
    catalogNbr: nbr,
    title: `${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]} ${i}`,
    career: 'GRDO',
    credits: 3,
    sections: [{ id: i, classNbr: String(4000 + i), section: '01', component: 'LEC', instructor: 'Prof. X', meetings: [], seats: null, seatsUpdatedAt: null }],
  });
}

const t0 = performance.now();
const index = buildIndex(courses);
const buildMs = performance.now() - t0;

// 'ICC3' es como se busca un código a medio escribir (y como PUCMM los
// escribe): tiene que traer los ICC-3xx y hacerlo dentro del frame igual.
const queries = ['calc', 'fisica', 'estruct', 'ICC-303', 'ICC3', 'redes', 'programacion', 'algebra', 'datos'];
let worst = 0;
let sum = 0;
for (const q of queries) {
  const s = performance.now();
  index.search(q);
  const d = performance.now() - s;
  sum += d;
  worst = Math.max(worst, d);
}
const avg = sum / queries.length;

console.log(`Catálogo sintético: ${courses.length} materias`);
console.log(`  build del índice: ${buildMs.toFixed(1)} ms (una vez por sesión)`);
console.log(`  búsqueda promedio: ${avg.toFixed(2)} ms · peor caso: ${worst.toFixed(2)} ms  /  presupuesto 16 ms`);
if (worst > 16) {
  console.error('✗ Alguna búsqueda pasó de un frame');
  process.exit(1);
}
console.log('✓ Cada búsqueda dentro de un frame');
