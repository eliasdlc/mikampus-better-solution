import type { CatalogCourse, CatalogSection, RequirementGroup } from './schemas.ts';
import { solveCombinations, type CandidateCourse, type CandidateSection } from './solver.ts';

// Fase 9: recomendador local y explicable. No consulta el portal ni la DB;
// recibe snapshots ya leídos y devuelve una propuesta que siempre cabe en al
// menos una combinación del solver. La prioridad es la posición del pénsum,
// no un score opaco: primero se drena el período pendiente más viejo.

export type RecommendationHistoryItem = {
  courseCode: string | null;
  status: 'taken' | 'in_progress' | 'transferred' | string;
};

export type RecommendedAlternative = {
  courseId: number;
  code: string;
  title: string;
  credits: number;
  sections: number;
};

export type RecommendedCourse = {
  courseId: number;
  code: string;
  title: string;
  credits: number;
  kind: 'obligatoria' | 'electiva';
  groupId: number;
  groupLabel: string;
  periodLabel: string;
  reason: string;
  section: CatalogSection;
  alternatives: RecommendedAlternative[];
};

export type RecommendationResult = {
  maxCredits: number;
  totalCredits: number;
  recommendations: RecommendedCourse[];
  schedule: {
    valid: boolean;
    adjusted: boolean;
    omitted: Array<{ code: string; reason: string }>;
  };
  caveats: string[];
};

type Option = {
  course: CatalogCourse;
  credits: number;
};

type Task = {
  kind: 'obligatoria' | 'electiva';
  group: RequirementGroup;
  period: RequirementGroup;
  options: Option[];
};

function descendants(group: RequirementGroup): RequirementGroup[] {
  return group.children.flatMap((child) => [child, ...descendants(child)]);
}

function candidateSection(course: CatalogCourse, section: CatalogSection): CandidateSection {
  return {
    id: section.id,
    courseId: course.id,
    code: course.code,
    title: course.title,
    classNbr: section.classNbr,
    section: section.section,
    component: section.component,
    instructor: section.instructor,
    meetings: section.meetings,
  };
}

function solverCourse(option: Option): CandidateCourse {
  return {
    courseId: option.course.id,
    code: option.course.code,
    title: option.course.title,
    sections: option.course.sections.map((section) => candidateSection(option.course, section)),
  };
}

function periodLabel(period: RequirementGroup): string {
  if (period.year != null && period.period != null) return `Año ${period.year} Período ${period.period}`;
  return period.label;
}

function creditsOf(course: CatalogCourse, units: number | null): number | null {
  const value = units ?? course.credits;
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function offeredOption(
  code: string,
  units: number | null,
  catalogByCode: Map<string, CatalogCourse>
): Option | null {
  const course = catalogByCode.get(code);
  if (!course || course.sections.length === 0) return null;
  const credits = creditsOf(course, units);
  return credits == null ? null : { course, credits };
}

function buildTasks(
  root: RequirementGroup,
  catalogByCode: Map<string, CatalogCourse>,
  completed: Set<string>
): Task[] {
  const periods = [root, ...descendants(root)]
    .filter((group) => group.kind === 'periodo' && !group.satisfied)
    .sort((a, b) => a.position - b.position);
  const tasks: Task[] = [];
  const mandatorySeen = new Set<string>();

  for (const period of periods) {
    const groups = descendants(period).sort((a, b) => a.position - b.position);
    for (const group of groups) {
      if (group.satisfied) continue;
      if (group.kind === 'electiva') {
        const byCode = new Map<string, Option>();
        for (const item of group.items) {
          if (!item.isCandidate || item.status !== 'pending' || completed.has(item.code)) continue;
          const option = offeredOption(item.code, item.units, catalogByCode);
          if (option) byCode.set(item.code, option);
        }
        const options = [...byCode.values()].sort((a, b) =>
          b.course.sections.length - a.course.sections.length || a.course.code.localeCompare(b.course.code)
        );
        if (options.length) tasks.push({ kind: 'electiva', group, period, options });
        continue;
      }

      for (const item of group.items) {
        if (item.isCandidate || item.status !== 'pending' || completed.has(item.code) || mandatorySeen.has(item.code)) {
          continue;
        }
        const option = offeredOption(item.code, item.units, catalogByCode);
        if (!option) continue;
        mandatorySeen.add(item.code);
        tasks.push({ kind: 'obligatoria', group, period, options: [option] });
      }
    }
  }
  return tasks;
}

export function recommendCourses({
  requirements,
  history = [],
  catalog,
  maxCredits,
}: {
  requirements: RequirementGroup | null;
  history?: RecommendationHistoryItem[];
  catalog: CatalogCourse[];
  maxCredits: number;
}): RecommendationResult {
  if (!Number.isFinite(maxCredits) || maxCredits <= 0) throw new Error('La carga máxima debe ser mayor que cero');

  const caveats = [
    'Confirma que las materias se ofertan y caben en un horario; los prerrequisitos esperan el pénsum oficial.',
  ];
  if (!requirements) {
    return {
      maxCredits,
      totalCredits: 0,
      recommendations: [],
      schedule: { valid: false, adjusted: false, omitted: [] },
      caveats: ['Sincronizá tu pénsum para poder generar una recomendación.'],
    };
  }

  const catalogByCode = new Map(catalog.map((course) => [course.code, course]));
  const completed = new Set(
    history
      .filter((item) => item.courseCode && ['taken', 'in_progress', 'transferred'].includes(item.status))
      .map((item) => item.courseCode as string)
  );
  const tasks = buildTasks(requirements, catalogByCode, completed);

  const selected: Array<{ task: Task; option: Option }> = [];
  const usedCodes = new Set<string>();
  const omitted: Array<{ code: string; reason: string }> = [];
  let totalCredits = 0;

  for (const task of tasks) {
    let chosen: Option | null = null;
    let sawWithinLoad = false;
    for (const option of task.options) {
      if (usedCodes.has(option.course.code)) continue; // una candidata nunca llena dos slots
      if (totalCredits + option.credits > maxCredits) continue;
      sawWithinLoad = true;
      const proposal = [...selected.map((entry) => solverCourse(entry.option)), solverCourse(option)];
      if (solveCombinations(proposal, { limit: 1 }).combinations.length === 0) continue;
      chosen = option;
      break;
    }

    if (!chosen) {
      if (sawWithinLoad) {
        const code = task.kind === 'electiva' ? task.group.label : task.options[0].course.code;
        omitted.push({ code, reason: 'No cabe sin choques con las materias de mayor prioridad.' });
      }
      continue;
    }
    selected.push({ task, option: chosen });
    usedCodes.add(chosen.course.code);
    totalCredits += chosen.credits;
  }

  const solved = solveCombinations(selected.map((entry) => solverCourse(entry.option)), { limit: 5000 });
  const best = solved.combinations[0] ?? null;
  const sectionByCourse = new Map((best?.sections ?? []).map((section) => [section.courseId, section.id]));

  const recommendations: RecommendedCourse[] = [];
  for (const { task, option } of selected) {
    const sectionId = sectionByCourse.get(option.course.id);
    const section = option.course.sections.find((entry) => entry.id === sectionId);
    // Defensa final: si el solver no devolvió grupo para cada materia, no sale
    // una recomendación parcial disfrazada de plan válido.
    if (!section) continue;
    const period = periodLabel(task.period);
    const alternatives = task.kind === 'electiva'
      ? task.options
          .filter((entry) => entry.course.code !== option.course.code && !usedCodes.has(entry.course.code))
          .map((entry) => ({
            courseId: entry.course.id,
            code: entry.course.code,
            title: entry.course.title,
            credits: entry.credits,
            sections: entry.course.sections.length,
          }))
      : [];
    recommendations.push({
      courseId: option.course.id,
      code: option.course.code,
      title: option.course.title,
      credits: option.credits,
      kind: task.kind,
      groupId: task.group.id,
      groupLabel: task.group.label,
      periodLabel: period,
      reason: task.kind === 'electiva'
        ? `${task.group.label}: ${task.options.length} candidata(s) se ofertan en ${period}.`
        : `Pendiente de ${period}: es de lo más antiguo que te falta y se oferta este ciclo.`,
      section,
      alternatives,
    });
  }

  const valid = recommendations.length > 0 && recommendations.length === selected.length && best != null;
  return {
    maxCredits,
    totalCredits: recommendations.reduce((sum, item) => sum + item.credits, 0),
    recommendations: valid ? recommendations : [],
    schedule: {
      valid,
      adjusted: omitted.length > 0,
      omitted,
    },
    caveats,
  };
}
