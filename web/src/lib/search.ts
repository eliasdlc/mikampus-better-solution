import MiniSearch from 'minisearch';
import type { CatalogCourse } from '../../../src/shared/schemas.ts';

// Normalización propia de acentos: "fisica" encuentra "Física", "calculo"
// encuentra "Cálculo". MiniSearch aplica processTerm tanto al indexar como al
// buscar, así que ambos lados quedan sin diacríticos.
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

// Un documento por materia. Los profesores de todas las secciones se aplanan a
// un campo para poder buscar por profesor sin duplicar materias en resultados.
type Doc = { id: number; title: string; code: string; codeCompact: string; subject: string; instructors: string };

export function buildIndex(courses: CatalogCourse[]) {
  const index = new MiniSearch<Doc>({
    fields: ['title', 'code', 'codeCompact', 'subject', 'instructors'],
    storeFields: ['id'],
    processTerm: (term) => fold(term),
    searchOptions: {
      prefix: true,
      fuzzy: 0.2,
      boost: { code: 3, codeCompact: 3, title: 2 },
      combineWith: 'AND',
    },
  });
  index.addAll(
    courses.map((c) => ({
      id: c.id,
      title: c.title,
      code: c.code,
      // "ICC-303" se tokeniza en "icc" y "303", así que escribir "icc3" no
      // matcheaba NADA por código: sobrevivía de casualidad por el fuzzy, y
      // devolvía ICC-101 antes que cualquier ICC-3xx. Indexado también junto
      // ("icc303"), el prefijo funciona — y "ICC303" es justo como la PUCMM
      // escribe sus códigos (ver shared/courseCode.ts).
      codeCompact: c.code.replace(/-/g, ''),
      subject: c.subject,
      instructors: c.sections.map((s) => s.instructor ?? '').join(' '),
    }))
  );
  return index;
}
