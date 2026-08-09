import type { CatalogCourse, CatalogSection, RequirementGroup } from './schemas.ts';
import { solveCombinations, DEFAULT_WEIGHTS, type CandidateCourse, type CandidateSection, type Weights } from './solver.ts';
import type { PensumPlan } from './pensumRules.ts';
import { coreqClosure, evaluate, missingCoreqs, unlockCount, type CourseStanding, type Eligibility } from './eligibility.ts';

// Recomendador local y explicable. No consulta el portal ni la DB: recibe
// snapshots ya leídos y devuelve una propuesta que cabe en un horario real.
//
// Qué cambió, y por qué:
//
//   1. ANTES no sabía de prerrequisitos — no existían en ningún dato de la app,
//      y el propio motor lo admitía en un caveat. Proponía Física II sin Física
//      I con total naturalidad. Ahora el plan académico oficial
//      (shared/pensum/*.json) es parte del modelo y cada candidata pasa por
//      shared/eligibility.ts.
//
//   2. ANTES perdía los laboratorios. Los labs de física valen 0 unidades, y el
//      filtro de créditos descartaba en silencio todo lo que no valiera más de
//      cero. Ahora una materia y sus co-requisitos son UN paquete indivisible:
//      entran juntos o no entra ninguno.
//
//   3. ANTES solo sabía drenar lo más viejo. Eso sirve si estás atrasado
//      parejo, pero no si estás desalineado — con el tronco de ICC al día y
//      deudas de FIS/MAT de años anteriores. Ahora hay dos estrategias y las
//      dos se calculan: elegir es del estudiante, no del algoritmo.
//
//   4. ANTES lo que NO podía proponer desaparecía sin explicación. Ahora sale
//      en `blocked` con el motivo — que suele ser la información más útil de
//      todas, porque dice qué hay que aprobar para desatascar la carrera.

export type RecommendationHistoryItem = {
  courseCode: string | null;
  status: 'taken' | 'in_progress' | 'transferred' | string;
  credits?: number | null;
};

/** Drenar la deuda más vieja, o abrir el camino más largo que queda por delante. */
export type Strategy = 'ponerse-al-dia' | 'avanzar';

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
  /** Cuántas materias del plan destraba aprobar ésta. */
  unlocks: number;
  /** Entró porque es co-requisito de otra (el laboratorio de su teoría). */
  requiredBy: string | null;
  /** Prerrequisitos que solo se cumplen si aprobás lo que cursás ahora. */
  conditionalOn: string[];
};

export type BlockedCourse = {
  code: string;
  title: string;
  periodLabel: string;
  reason: string;
  /** Qué hay que aprobar antes. Vacío si el bloqueo no es por prerrequisito. */
  missing: string[];
};

export type RecommendationResult = {
  strategy: Strategy;
  maxCredits: number;
  totalCredits: number;
  recommendations: RecommendedCourse[];
  blocked: BlockedCourse[];
  schedule: {
    valid: boolean;
    adjusted: boolean;
    omitted: Array<{ code: string; reason: string }>;
  };
  caveats: string[];
};

type Option = { course: CatalogCourse; credits: number };

/** Una materia con sus co-requisitos: la unidad mínima que se puede inscribir. */
type Bundle = {
  lead: Option;
  /** El paquete completo, la materia incluida. */
  members: Option[];
  credits: number;
  eligibility: Eligibility;
  unlocks: number;
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

// Las unidades salen del informe de avance, del plan oficial o del catálogo, en
// ese orden. Ojo con el cero: un laboratorio de física vale 0 unidades DE
// VERDAD, y tratarlo como dato faltante era justamente el bug que los borraba
// del plan recomendado. Solo un valor negativo o no numérico es inválido.
function creditsOf(course: CatalogCourse, units: number | null, plan: PensumPlan | null): number | null {
  for (const value of [units, plan?.courses?.[course.code]?.units ?? null, course.credits]) {
    if (value != null && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function offeredOption(
  code: string,
  units: number | null,
  catalogByCode: Map<string, CatalogCourse>,
  plan: PensumPlan | null
): Option | null {
  const course = catalogByCode.get(code);
  if (!course || course.sections.length === 0) return null;
  const credits = creditsOf(course, units, plan);
  return credits == null ? null : { course, credits };
}

function buildTasks(
  root: RequirementGroup,
  catalogByCode: Map<string, CatalogCourse>,
  completed: Set<string>,
  plan: PensumPlan | null,
  exclude: Set<string>
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
          if (!item.isCandidate || item.status !== 'pending') continue;
          if (completed.has(item.code) || exclude.has(item.code)) continue;
          const option = offeredOption(item.code, item.units, catalogByCode, plan);
          if (option) byCode.set(item.code, option);
        }
        const options = [...byCode.values()].sort(
          (a, b) => b.course.sections.length - a.course.sections.length || a.course.code.localeCompare(b.course.code)
        );
        if (options.length) tasks.push({ kind: 'electiva', group, period, options });
        continue;
      }

      for (const item of group.items) {
        if (item.isCandidate || item.status !== 'pending') continue;
        if (completed.has(item.code) || exclude.has(item.code) || mandatorySeen.has(item.code)) continue;
        const option = offeredOption(item.code, item.units, catalogByCode, plan);
        if (!option) continue;
        mandatorySeen.add(item.code);
        tasks.push({ kind: 'obligatoria', group, period, options: [option] });
      }
    }
  }
  return tasks;
}

/**
 * Arma el paquete de una candidata: ella más los co-requisitos que le faltan.
 * Devuelve null si algún co-requisito no se oferta este ciclo — en ese caso la
 * materia no es cursable aunque ella misma tenga cupo, y decirlo así es más
 * honesto que proponer media inscripción que el portal va a rechazar.
 */
function bundleFor(
  option: Option,
  plan: PensumPlan | null,
  standing: CourseStanding,
  catalogByCode: Map<string, CatalogCourse>
): { bundle: Bundle } | { missingCoreq: string[] } {
  const codes = coreqClosure(plan, [option.course.code]);
  const members: Option[] = [];
  const unavailable: string[] = [];

  for (const code of codes) {
    if (code === option.course.code) {
      members.push(option);
      continue;
    }
    // Un co-requisito ya aprobado o en curso no hay que volver a tomarlo: es el
    // caso real de quien reprobó la teoría pero pasó el laboratorio.
    if (standing.approved.has(code) || standing.inProgress.has(code)) continue;
    const member = offeredOption(code, plan?.courses?.[code]?.units ?? null, catalogByCode, plan);
    if (!member) {
      unavailable.push(code);
      continue;
    }
    members.push(member);
  }

  if (unavailable.length) return { missingCoreq: unavailable };

  const together = members.map((m) => m.course.code);
  const eligibility = evaluate(plan, option.course.code, standing, together);
  return {
    bundle: {
      lead: option,
      members,
      credits: members.reduce((sum, m) => sum + m.credits, 0),
      eligibility,
      unlocks: members.reduce((max, m) => Math.max(max, unlockCount(plan, m.course.code)), 0),
    },
  };
}

function blockerText(eligibility: Eligibility, plan: PensumPlan | null): string {
  const prereqs = eligibility.blockers.filter((b) => b.kind === 'prereq').map((b) => (b as { code: string }).code);
  if (prereqs.length) {
    const titled = prereqs.map((code) => {
      const title = plan?.courses?.[code]?.title;
      return title ? `${code} (${title})` : code;
    });
    return `Te falta aprobar ${titled.join(' y ')}.`;
  }
  const gate = eligibility.blockers.find((b) => b.kind === 'gate');
  if (gate && gate.kind === 'gate') {
    return `El plan la reserva para cuando tengas aprobado el ${Math.round(gate.ratio * 100)}% de los créditos.`;
  }
  const coreq = eligibility.blockers.find((b) => b.kind === 'coreq');
  if (coreq && coreq.kind === 'coreq') {
    return `Necesita cursarse junto con ${coreq.code}, que no se oferta este ciclo.`;
  }
  return 'No cumple los requisitos del plan académico.';
}

export function recommendCourses({
  requirements,
  plan = null,
  history = [],
  catalog,
  maxCredits,
  strategy = 'ponerse-al-dia',
  include = [],
  exclude = [],
  weights = DEFAULT_WEIGHTS,
}: {
  requirements: RequirementGroup | null;
  plan?: PensumPlan | null;
  history?: RecommendationHistoryItem[];
  catalog: CatalogCourse[];
  maxCredits: number;
  strategy?: Strategy;
  /** Materias que el estudiante quiere sí o sí (entran primero). */
  include?: string[];
  /** Materias que el estudiante descarta para este ciclo. */
  exclude?: string[];
  weights?: Weights;
}): RecommendationResult {
  if (!Number.isFinite(maxCredits) || maxCredits <= 0) throw new Error('La carga máxima debe ser mayor que cero');

  const caveats: string[] = [];
  if (!plan) {
    caveats.push(
      'Sin el plan académico oficial de tu carrera, esta propuesta no puede verificar prerrequisitos: confirmalos con tu asesor.'
    );
  } else if (plan.source?.fetchedAt) {
    caveats.push(
      `Prerrequisitos según el plan ${plan.plan} emitido el ${plan.issuedAt ?? plan.source.fetchedAt}. El portal manda si discrepan.`
    );
  }

  if (!requirements) {
    return {
      strategy,
      maxCredits,
      totalCredits: 0,
      recommendations: [],
      blocked: [],
      schedule: { valid: false, adjusted: false, omitted: [] },
      caveats: ['Sincronizá tu pénsum para poder generar una recomendación.'],
    };
  }

  const catalogByCode = new Map(catalog.map((course) => [course.code, course]));
  const excluded = new Set(exclude);
  const forced = new Set(include);

  const approved = new Set<string>();
  const inProgress = new Set<string>();
  let approvedUnits = 0;
  for (const item of history) {
    if (!item.courseCode) continue;
    if (item.status === 'in_progress') {
      inProgress.add(item.courseCode);
      continue;
    }
    if (item.status === 'taken' || item.status === 'transferred') {
      approved.add(item.courseCode);
      if (Number.isFinite(item.credits ?? NaN)) approvedUnits += Number(item.credits);
    }
  }
  const standing: CourseStanding = { approved, inProgress, approvedUnits };
  // Lo aprobado y lo que se cursa hoy no vuelve a proponerse.
  const completed = new Set([...approved, ...inProgress]);

  const tasks = buildTasks(requirements, catalogByCode, completed, plan, excluded);

  // Cada tarea se convierte en paquetes candidatos (materia + sus labs), ya
  // evaluados contra el plan. Lo que no pasa el filtro no se descarta en
  // silencio: se guarda con su motivo.
  const blocked: BlockedCourse[] = [];
  const seenBlocked = new Set<string>();
  const viable: Array<{ task: Task; bundle: Bundle; position: number }> = [];

  for (const task of tasks) {
    for (const option of task.options) {
      const code = option.course.code;
      const note = (reason: string, missing: string[] = []) => {
        if (seenBlocked.has(code)) return;
        seenBlocked.add(code);
        blocked.push({ code, title: option.course.title, periodLabel: periodLabel(task.period), reason, missing });
      };

      // El prerrequisito se revisa PRIMERO aunque el paquete no se pueda armar:
      // "te falta aprobar Física I" explica el bloqueo de verdad, mientras que
      // "su co-requisito no se oferta" es un síntoma que además se arregla solo
      // el ciclo que viene. Decir el segundo cuando el problema es el primero
      // manda al estudiante a resolver lo que no le corresponde.
      const solo = evaluate(plan, code, standing, [code, ...coreqClosure(plan, [code])]);
      if (solo.blockers.length > 0) {
        note(
          blockerText(solo, plan),
          solo.blockers.filter((b) => b.kind === 'prereq').map((b) => (b as { code: string }).code)
        );
        continue;
      }

      const built = bundleFor(option, plan, standing, catalogByCode);
      if ('missingCoreq' in built) {
        const titles = built.missingCoreq.map((c) => {
          const title = plan?.courses?.[c]?.title;
          return title ? `${c} (${title})` : c;
        });
        note(
          `El plan exige cursarla junto con ${titles.join(' y ')}, y eso no tiene grupos este ciclo.`,
          built.missingCoreq
        );
        continue;
      }
      const { bundle } = built;
      if (!bundle.eligibility.eligible) {
        note(
          blockerText(bundle.eligibility, plan),
          bundle.eligibility.blockers.filter((b) => b.kind === 'prereq').map((b) => (b as { code: string }).code)
        );
        continue;
      }
      viable.push({ task, bundle, position: task.period.position });
    }
  }

  // El orden ES la recomendación. "Ponerse al día" drena la deuda más vieja del
  // pénsum; "avanzar" ataca primero los cuellos de botella — las materias que
  // más cosas destraban — porque atrasarse en ICC-104 cuesta seis materias y
  // atrasarse en una electiva no cuesta ninguna.
  const rank = (entry: { task: Task; bundle: Bundle; position: number }) => {
    const forcedFirst = forced.has(entry.bundle.lead.course.code) ? 0 : 1;
    return strategy === 'avanzar'
      ? [forcedFirst, -entry.bundle.unlocks, entry.position]
      : [forcedFirst, entry.position, -entry.bundle.unlocks];
  };
  viable.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return a.bundle.lead.course.code.localeCompare(b.bundle.lead.course.code);
  });

  const selected: Array<{ task: Task; bundle: Bundle }> = [];
  const usedCodes = new Set<string>();
  const usedGroups = new Set<number>();
  const omitted: Array<{ code: string; reason: string }> = [];
  const omittedSeen = new Set<string>();
  let totalCredits = 0;

  for (const entry of viable) {
    const { task, bundle } = entry;
    // Una electiva llena un solo slot de su grupo, y una materia no puede
    // ocupar dos slots.
    if (task.kind === 'electiva' && usedGroups.has(task.group.id)) continue;
    if (bundle.members.some((m) => usedCodes.has(m.course.code))) continue;

    const label = task.kind === 'electiva' ? task.group.label : bundle.lead.course.code;
    if (totalCredits + bundle.credits > maxCredits) {
      if (!omittedSeen.has(label)) {
        omittedSeen.add(label);
        omitted.push({
          code: label,
          reason: `No cabe en ${maxCredits} créditos (${bundle.credits} más de los ${totalCredits} ya propuestos).`,
        });
      }
      continue;
    }

    const proposal = [
      ...selected.flatMap((e) => e.bundle.members.map(solverCourse)),
      ...bundle.members.map(solverCourse),
    ];
    if (solveCombinations(proposal, { limit: 1 }).combinations.length === 0) {
      if (!omittedSeen.has(label)) {
        omittedSeen.add(label);
        omitted.push({ code: label, reason: 'No cabe sin choques con las materias de mayor prioridad.' });
      }
      continue;
    }

    selected.push({ task, bundle });
    for (const member of bundle.members) usedCodes.add(member.course.code);
    if (task.kind === 'electiva') usedGroups.add(task.group.id);
    totalCredits += bundle.credits;
  }

  const solved = solveCombinations(
    selected.flatMap((entry) => entry.bundle.members.map(solverCourse)),
    { limit: 5000, weights }
  );
  const best = solved.combinations[0] ?? null;
  const sectionByCourse = new Map((best?.sections ?? []).map((section) => [section.courseId, section.id]));

  const recommendations: RecommendedCourse[] = [];
  for (const { task, bundle } of selected) {
    const period = periodLabel(task.period);
    for (const member of bundle.members) {
      const sectionId = sectionByCourse.get(member.course.id);
      const section = member.course.sections.find((entry) => entry.id === sectionId);
      // Defensa final: si el solver no devolvió grupo para cada materia, no
      // sale una recomendación parcial disfrazada de plan válido.
      if (!section) continue;
      const isLead = member.course.code === bundle.lead.course.code;
      const alternatives =
        isLead && task.kind === 'electiva'
          ? task.options
              .filter((entry) => entry.course.code !== member.course.code && !usedCodes.has(entry.course.code))
              .map((entry) => ({
                courseId: entry.course.id,
                code: entry.course.code,
                title: entry.course.title,
                credits: entry.credits,
                sections: entry.course.sections.length,
              }))
          : [];

      recommendations.push({
        courseId: member.course.id,
        code: member.course.code,
        title: member.course.title,
        credits: member.credits,
        kind: task.kind,
        groupId: task.group.id,
        groupLabel: task.group.label,
        periodLabel: period,
        reason: reasonFor({ isLead, task, bundle, period, strategy }),
        section,
        alternatives,
        unlocks: unlockCount(plan, member.course.code),
        requiredBy: isLead ? null : bundle.lead.course.code,
        conditionalOn: isLead ? bundle.eligibility.conditionalOn : [],
      });
    }
  }

  const expected = selected.reduce((sum, entry) => sum + entry.bundle.members.length, 0);
  const valid = recommendations.length > 0 && recommendations.length === expected && best != null;

  const conditional = recommendations.flatMap((item) => item.conditionalOn);
  if (conditional.length) {
    caveats.push(
      `Esta propuesta da por aprobado lo que cursás ahora (${[...new Set(conditional)].join(', ')}). Si reprobás alguna, deja de ser válida.`
    );
  }

  return {
    strategy,
    maxCredits,
    totalCredits: recommendations.reduce((sum, item) => sum + item.credits, 0),
    recommendations: valid ? recommendations : [],
    blocked,
    schedule: { valid, adjusted: omitted.length > 0, omitted },
    caveats,
  };
}

function reasonFor({
  isLead,
  task,
  bundle,
  period,
  strategy,
}: {
  isLead: boolean;
  task: Task;
  bundle: Bundle;
  period: string;
  strategy: Strategy;
}): string {
  if (!isLead) {
    return `El plan exige cursarla junto a ${bundle.lead.course.code}: son una sola materia repartida en dos inscripciones.`;
  }
  if (task.kind === 'electiva') {
    return `${task.group.label}: ${task.options.length} candidata(s) se ofertan en ${period}.`;
  }
  if (strategy === 'avanzar' && bundle.unlocks > 0) {
    return `Aprobarla destraba ${bundle.unlocks} materia(s) del plan. Es de ${period}.`;
  }
  const extra = bundle.unlocks > 0 ? ` Además destraba ${bundle.unlocks} materia(s).` : '';
  return `Pendiente de ${period}: es de lo más antiguo que te falta y se oferta este ciclo.${extra}`;
}

export { missingCoreqs };
