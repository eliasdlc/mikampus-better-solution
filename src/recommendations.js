import { readCatalog } from './peoplesoft/catalog.js';
import { readGrades } from './peoplesoft/grades.js';
import { readRequirementTree } from './peoplesoft/advisement.js';
import { recommendCourses } from './shared/recommend.ts';

export const DEFAULT_MAX_CREDITS = 18;

// Adaptador DB → motor puro. Mantenerlo separado hace que recommend.ts se
// pruebe con objetos pequeños y que este endpoint siga siendo lectura local
// (<10ms, cero PeopleSoft).
export function recommendationForTerm(term, maxCredits = DEFAULT_MAX_CREDITS) {
  if (!term?.trim()) throw new Error('No hay próximo término con secciones para recomendar');
  const load = Number(maxCredits);
  const result = recommendCourses({
    requirements: readRequirementTree(),
    history: readGrades().map((course) => ({ courseCode: course.code, status: course.status })),
    catalog: readCatalog(term.trim()).courses,
    maxCredits: load,
  });
  return {
    term: term.trim(),
    generatedAt: new Date().toISOString(),
    ...result,
  };
}
