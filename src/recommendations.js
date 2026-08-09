import { readCatalog } from './peoplesoft/catalog.js';
import { readGrades } from './peoplesoft/grades.js';
import { readRequirementTree, readProfile, readPensum } from './peoplesoft/advisement.js';
import { recommendCourses } from './shared/recommend.ts';
import { isApproved } from './shared/gpa.ts';
import { planFor } from './shared/pensum/index.ts';

export const DEFAULT_MAX_CREDITS = 18;
export const STRATEGIES = ['ponerse-al-dia', 'avanzar'];

// Adaptador DB → motor puro. Mantenerlo separado hace que recommend.ts se
// pruebe con objetos pequeños y que este endpoint siga siendo lectura local
// (<10ms, cero PeopleSoft).

// El plan académico oficial de ESTE estudiante. Sale de su perfil del portal
// (carrera + número de pénsum), no de una constante: dos estudiantes de la
// misma app pueden estar en planes distintos, y uno de 2015 no tiene por qué
// regirse por las reglas de 2020.
export function planForUser(userId) {
  const profile = readProfile(userId);
  return planFor({ pensumNo: profile?.pensum_no ?? null, career: profile?.career ?? null });
}

// Qué tiene aprobado el estudiante, de verdad.
//
// Acá vivía el peor error del recomendador viejo, y era silencioso: tomaba el
// histórico de notas y contaba como aprobada TODA materia con status "taken" —
// que el scraper pone en cualquier fila con nota, incluidas las F (reprobada) y
// las R (retirada). Con FIS-139 en F y R, la app creía que Física I estaba
// aprobada y proponía Física II con toda tranquilidad.
//
// Lo arregla la NOTA, que es el dato que siempre estuvo ahí sin usarse: una F o
// una R nunca aprobaron nada (isApproved, en shared/gpa.ts). El informe de
// avance se suma encima porque conoce lo que el histórico no lista —
// convalidaciones y materias de antes del período que el portal expone— pero
// solo puede SUMAR: nunca degrada una materia que estás cursando ahora, porque
// el informe es una foto de cuando se generó y la inscripción de hoy es más
// nueva que él.
function academicStanding(userId) {
  const byCode = new Map();
  // taken > in_progress > failed: un segundo intento aprobado no se anula
  // porque el primero haya sido F.
  const RANK = { taken: 3, in_progress: 2, failed: 1 };
  const put = (code, status, credits) => {
    if (!code) return;
    const previous = byCode.get(code);
    if (previous && RANK[previous.status] >= RANK[status]) {
      if (previous.credits == null && credits != null) previous.credits = credits;
      return;
    }
    byCode.set(code, { courseCode: code, status, credits: credits ?? previous?.credits ?? null });
  };

  for (const course of readGrades(userId)) {
    const status = isApproved(course.grade)
      ? 'taken'
      : course.grade == null && course.status !== 'taken'
        ? 'in_progress'
        : 'failed';
    put(course.code, status, course.units ?? null);
  }

  for (const row of readPensum(userId)) {
    if (row.status === 'taken' || row.status === 'transferred') put(row.code, 'taken', row.units ?? null);
    else if (row.status === 'in_progress') put(row.code, 'in_progress', row.units ?? null);
  }

  return [...byCode.values()];
}

export function recommendationForTerm(userId, term, options = {}) {
  if (!term?.trim()) throw new Error('No hay próximo término con secciones para recomendar');
  const {
    maxCredits = DEFAULT_MAX_CREDITS,
    strategy = 'ponerse-al-dia',
    include = [],
    exclude = [],
    weights,
  } = options;

  const result = recommendCourses({
    requirements: readRequirementTree(userId),
    plan: planForUser(userId),
    history: academicStanding(userId),
    catalog: readCatalog(term.trim()).courses,
    maxCredits: Number(maxCredits),
    strategy,
    include,
    exclude,
    ...(weights ? { weights } : {}),
  });

  return { term: term.trim(), generatedAt: new Date().toISOString(), ...result };
}

/**
 * Las dos propuestas del mismo ciclo, calculadas juntas.
 *
 * Elegir entre ponerse al día y avanzar no es una decisión de algoritmo: depende
 * de si te importa más no arrastrar deudas o no atrasar la graduación, y eso
 * solo lo sabe el estudiante. La app calcula ambas, muestra el porqué de cada
 * materia, y deja la decisión donde va.
 */
export function recommendationOptions(userId, term, options = {}) {
  const plan = planForUser(userId);
  return {
    term: term?.trim() ?? null,
    generatedAt: new Date().toISOString(),
    plan: plan ? { code: plan.plan, career: plan.career, issuedAt: plan.issuedAt } : null,
    proposals: STRATEGIES.map((strategy) => recommendationForTerm(userId, term, { ...options, strategy })),
  };
}
