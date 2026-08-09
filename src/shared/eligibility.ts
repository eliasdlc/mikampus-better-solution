import type { PensumPlan, PensumCourseRule } from './pensumRules.ts';

// ¿Puedo cursar esta materia el ciclo que viene?
//
// El recomendador anterior no se hacía esa pregunta: ordenaba lo pendiente por
// posición en el pénsum y proponía lo que cupiera en el horario. Eso produce
// planes imposibles con total seguridad — ICC-303 antes que Sistemas
// Operativos, o Física II sin haber aprobado Física I.
//
// Tres reglas, y ninguna inventada: las tres están escritas en el plan
// académico oficial (ver pensumRules.ts).
//
//   prerrequisito  debe estar APROBADO antes de empezar.
//   co-requisito   debe cursarse antes o AL MISMO TIEMPO. Es lo que ata cada
//                  laboratorio a su teoría, y por eso un plan que trae FIS-219
//                  sin su laboratorio no es un plan válido, es un error.
//   compuerta      reglas en prosa del plan ("FIL-363 exige el 70% de los
//                  créditos aprobados").
//
// Sobre lo que está EN CURSO: para un ciclo futuro, una materia que estás
// cursando ahora ya estará aprobada — si la aprobás. Contarla como satisfecha
// es lo correcto, pero deja el plan condicionado, y eso se dice en voz alta
// (`conditionalOn`) en vez de esconderse.

export type CourseStanding = {
  /** Aprobadas: cuentan para prerrequisitos sin condiciones. */
  approved: Set<string>;
  /** En curso ahora: cuentan, pero condicionan el plan a aprobarlas. */
  inProgress: Set<string>;
  /** Unidades ya aprobadas, para las compuertas por porcentaje. */
  approvedUnits: number;
};

export type Blocker =
  | { kind: 'prereq'; code: string; approved: false }
  | { kind: 'coreq'; code: string }
  | { kind: 'gate'; ratio: number; text: string };

export type Eligibility = {
  code: string;
  eligible: boolean;
  blockers: Blocker[];
  /** Prerrequisitos que solo se cumplen si aprobás lo que cursás hoy. */
  conditionalOn: string[];
  /** Materias que hay que agregar al mismo ciclo para que esta sea válida. */
  requiresAlongside: string[];
  /** Sin regla en el plan: no se bloquea, pero tampoco se garantiza. */
  unknown: boolean;
};

/**
 * Resuelve un código contra el plan considerando las recodificaciones. Devuelve
 * todos los códigos que valen como "esta misma materia".
 */
export function equivalents(plan: PensumPlan, code: string): string[] {
  const aliases = (plan.aliases ?? {}) as Record<string, string[]>;
  const set = new Set([code, ...(aliases[code] ?? [])]);
  // La equivalencia es simétrica: si el plan dice MAT-110 y el estudiante tiene
  // ESG-105, preguntar por cualquiera de las dos tiene que funcionar.
  for (const [canonical, others] of Object.entries(aliases)) {
    if (others.includes(code)) {
      set.add(canonical);
      for (const other of others) set.add(other);
    }
  }
  return [...set];
}

function held(plan: PensumPlan, standing: Set<string>, code: string): boolean {
  return equivalents(plan, code).some((candidate) => standing.has(candidate));
}

/**
 * Evalúa una materia contra el plan y la situación del estudiante.
 *
 * `alongside` son las materias que van en el MISMO ciclo propuesto: es lo que
 * permite que un laboratorio satisfaga el co-requisito de su teoría.
 */
export function evaluate(
  plan: PensumPlan | null,
  code: string,
  standing: CourseStanding,
  alongside: Iterable<string> = []
): Eligibility {
  const base: Eligibility = {
    code,
    eligible: true,
    blockers: [],
    conditionalOn: [],
    requiresAlongside: [],
    unknown: false,
  };
  const rule: PensumCourseRule | undefined = plan?.courses?.[code];
  if (!plan || !rule) {
    // Sin plan cargado, o materia que el plan no conoce (una electiva nueva, un
    // código recodificado después de la última emisión del reporte). No se
    // bloquea: el costo de callar una materia real es peor que el de proponer
    // una que el portal terminará rechazando con su propio mensaje.
    return { ...base, unknown: true };
  }

  const withMe = new Set([...alongside, code]);

  for (const prereq of rule.prereqs) {
    if (held(plan, standing.approved, prereq)) continue;
    if (held(plan, standing.inProgress, prereq)) {
      base.conditionalOn.push(prereq);
      continue;
    }
    // Un prerrequisito que este plan ni siquiera define es un código de otra
    // versión del pénsum (el reporte arrastra MAT-311 e ITT-344, que no
    // existen en ICC-2020). No puede bloquear: nadie podría aprobarlo nunca.
    if (!plan.courses[prereq]) continue;
    base.blockers.push({ kind: 'prereq', code: prereq, approved: false });
  }

  for (const coreq of rule.coreqs) {
    if (held(plan, standing.approved, coreq) || held(plan, standing.inProgress, coreq)) continue;
    if ([...withMe].some((entry) => equivalents(plan, coreq).includes(entry))) continue;
    // No es un bloqueo definitivo: se resuelve agregando la otra mitad al mismo
    // ciclo, y eso es exactamente lo que el recomendador hará.
    base.requiresAlongside.push(coreq);
    base.blockers.push({ kind: 'coreq', code: coreq });
  }

  for (const gate of plan.gates) {
    if (!equivalents(plan, gate.code).includes(code)) continue;
    const needed = (plan.totalUnits ?? 0) * gate.minApprovedRatio;
    if (standing.approvedUnits >= needed) continue;
    base.blockers.push({ kind: 'gate', ratio: gate.minApprovedRatio, text: gate.text });
  }

  base.eligible = base.blockers.length === 0;
  return base;
}

/**
 * El cierre de co-requisitos de un conjunto: dada una selección, devuelve las
 * materias que hay que sumarle para que ninguna quede coja.
 *
 * Es lo que hacía falta para los laboratorios. FIS-219 y su laboratorio son una
 * sola decisión académica repartida en dos filas del catálogo, y el
 * recomendador las trataba como dos materias sin relación — cuando además el
 * laboratorio vale 0 unidades y por eso se caía del filtro de créditos.
 */
export function coreqClosure(plan: PensumPlan | null, codes: Iterable<string>): string[] {
  if (!plan) return [...codes];
  const out = new Set<string>(codes);
  const queue = [...out];
  while (queue.length) {
    const code = queue.shift()!;
    for (const coreq of plan.courses[code]?.coreqs ?? []) {
      if (!plan.courses[coreq]) continue;
      if (equivalents(plan, coreq).some((candidate) => out.has(candidate))) continue;
      out.add(coreq);
      queue.push(coreq);
    }
  }
  return [...out];
}

/** Los co-requisitos de `code` que faltan en `have`. Vacío si está completo. */
export function missingCoreqs(plan: PensumPlan | null, code: string, have: Iterable<string>): string[] {
  if (!plan) return [];
  const present = new Set(have);
  return (plan.courses[code]?.coreqs ?? []).filter(
    (coreq) => plan.courses[coreq] && !equivalents(plan, coreq).some((candidate) => present.has(candidate))
  );
}

/**
 * Cuántas materias se desbloquean al aprobar ésta. Sirve para priorizar: en
 * ICC-2020, ICC-104 abre seis materias y FIL-363 ninguna. Atrasarse en la
 * primera cuesta un año; en la segunda, nada.
 */
export function unlockCount(plan: PensumPlan | null, code: string): number {
  if (!plan) return 0;
  let n = 0;
  for (const rule of Object.values(plan.courses)) {
    if (rule.prereqs.includes(code)) n++;
  }
  return n;
}
