import type { RequirementGroup } from './schemas.ts';
import type { PensumPlan } from './pensumRules.ts';
import { coreqClosure, equivalents, evaluate, unlockCount, type CourseStanding } from './eligibility.ts';
import { cycleOrdinal } from './trajectory.ts';
import { termSortKey } from './gpa.ts';

// La ruta a graduación: cuántos ciclos faltan DE VERDAD, y qué es lo que los
// impone.
//
// Hasta acá la app respondía esa pregunta con `cyclesLeft` de trajectory.ts, que
// es el conteo de períodos del pénsum sin cerrar. Ese número es correcto para
// quien va al día y es sistemáticamente falso para quien no: si te faltan tres
// materias sueltas repartidas en seis bloques distintos, el pénsum tiene seis
// períodos abiertos y a vos te faltan uno o dos ciclos, no seis. Justamente al
// estudiante atrasado —el que más necesita el número— se le decía lo peor.
//
// Acá el ciclo se calcula colocando lo que falta en el tiempo, respetando lo
// único que de verdad ordena una carrera:
//
//   1. los prerrequisitos, que encadenan materias y ponen un PISO que ninguna
//      carga de créditos puede bajar (aprobar Física I y II y III son tres
//      ciclos aunque tomes una sola materia por ciclo);
//   2. los co-requisitos, que son materias que entran o salen juntas;
//   3. las compuertas por porcentaje de créditos aprobados, que se abren solas
//      a medida que la ruta avanza;
//   4. el techo de créditos por ciclo, que es la otra restricción.
//
// De las dos restricciones, una manda. Decir CUÁL es la parte útil: si te frena
// la cadena de prerrequisitos, meter más créditos por ciclo no adelanta nada; si
// te frena la carga, sí. Esa distinción es la que convierte el número en una
// decisión.
//
// Todo es puro y determinista: mismos datos, misma ruta. No consulta el portal
// ni la base — recibe el árbol de requisitos y el plan ya leídos.

/** Los tres ciclos del calendario de PUCMM, por su índice dentro del año. */
const CYCLE_NAMES = ['Enero', 'Abril', 'Septiembre'];

export type DegreePathCourse = {
  code: string;
  title: string;
  credits: number;
  kind: 'obligatoria' | 'electiva';
  /** El bloque del pénsum del que viene ("Año 2 Período 3"). */
  blockLabel: string;
  /** Cuántas materias del plan destraba aprobarla. */
  unlocks: number;
  /** Ciclos que quedan por delante contándola a ella: su cadena más larga. */
  chainLength: number;
  /** Sin holgura: atrasarla un ciclo atrasa la graduación un ciclo. */
  critical: boolean;
  /** Entró arrastrada por su teoría (el laboratorio de una materia). */
  requiredBy: string | null;
  /** Prerrequisitos que solo se cumplen si aprobás lo que cursás ahora. */
  conditionalOn: string[];
};

export type DegreePathTerm = {
  /** 1 es el próximo ciclo a inscribir. */
  index: number;
  label: string | null;
  credits: number;
  courses: DegreePathCourse[];
};

export type DegreePathBlocker = {
  code: string;
  title: string;
  reason: string;
  missing: string[];
};

export type DegreePathBottleneck = {
  code: string;
  title: string;
  unlocks: number;
  chainLength: number;
  /** En qué ciclo de la ruta cae. */
  termIndex: number;
};

/** Qué restricción fija la duración: la cadena de prerrequisitos o la carga. */
export type DegreePathBinding = 'prerrequisitos' | 'carga' | 'ambas' | 'ninguna';

export type DegreePath = {
  available: boolean;
  /** Por qué no hay ruta, cuando `available` es false. */
  reason: string | null;
  maxCredits: number;
  terms: DegreePathTerm[];
  termsRemaining: number;
  creditsRemaining: number;
  coursesRemaining: number;
  /** El ciclo en que se cerraría la carrera, o null si no se pudo fechar. */
  graduationTerm: string | null;
  binding: DegreePathBinding;
  /** Piso impuesto por la cadena de prerrequisitos más larga. */
  chainFloor: number;
  /** Piso impuesto por los créditos que faltan sobre el techo por ciclo. */
  loadFloor: number;
  /** La cadena más larga que queda, en orden de cursado. */
  criticalPath: Array<{ code: string; title: string }>;
  /** Las materias que más cosas destraban, primero las de la ruta crítica. */
  bottlenecks: DegreePathBottleneck[];
  /** Lo que no se pudo colocar en ningún ciclo, con su motivo. */
  unscheduled: DegreePathBlocker[];
  caveats: string[];
};

type PendingCourse = {
  code: string;
  title: string;
  credits: number;
  kind: 'obligatoria' | 'electiva';
  blockLabel: string;
  /** Posición del bloque en el pénsum: desempata a favor de lo más viejo. */
  position: number;
};

// ── Lectura del árbol de requisitos ──────────────────────────────────────────

function descendants(group: RequirementGroup): RequirementGroup[] {
  return group.children.flatMap((child) => [child, ...descendants(child)]);
}

function blockLabel(period: RequirementGroup): string {
  if (period.year != null && period.period != null) return `Año ${period.year} Período ${period.period}`;
  return period.label;
}

/**
 * Los créditos de una electiva sin nombre: el grupo declara cuántas unidades y
 * cuántas materias le faltan, y el cociente es lo que vale cada slot. Sin esos
 * datos se asume 3, que es el valor de la enorme mayoría de las materias del
 * pénsum. Nunca 0: un slot de 0 créditos entraría gratis en cualquier ciclo.
 */
function electiveSlotCredits(group: RequirementGroup, slots: number): number {
  const units = group.units.needed;
  if (units != null && units > 0 && slots > 0) {
    const per = units / slots;
    if (Number.isFinite(per) && per > 0) return Math.round(per * 10) / 10;
  }
  return 3;
}

/** Cuántos slots de electiva quedan abiertos en un grupo sin satisfacer. */
function electiveSlots(group: RequirementGroup): number {
  const byCourses = group.courses.needed;
  if (byCourses != null && byCourses > 0) return byCourses;
  const byUnits = group.units.needed;
  if (byUnits != null && byUnits > 0) return Math.max(1, Math.ceil(byUnits / 3));
  return 0;
}

/**
 * Todo lo que falta, leído del árbol del advisement.
 *
 * Las obligatorias salen con su código real. Las electivas NO: una electiva es
 * un hueco con muchas candidatas, y comprometerse con una en particular sería
 * inventar una decisión que es del estudiante. Entran como slots anónimos que
 * ocupan créditos y no encadenan nada — que es exactamente su comportamiento
 * real en el tiempo.
 */
export function pendingFromRequirements(
  root: RequirementGroup,
  plan: PensumPlan | null,
  completed: Set<string>
): PendingCourse[] {
  const periods = [root, ...descendants(root)]
    .filter((group) => group.kind === 'periodo')
    .sort((a, b) => a.position - b.position);

  const out: PendingCourse[] = [];
  const seen = new Set<string>();

  for (const period of periods) {
    const label = blockLabel(period);
    for (const group of descendants(period).sort((a, b) => a.position - b.position)) {
      if (group.satisfied) continue;

      if (group.kind === 'electiva') {
        const slots = electiveSlots(group);
        const credits = electiveSlotCredits(group, slots);
        for (let i = 0; i < slots; i++) {
          out.push({
            code: `${group.label} · electiva ${i + 1}`,
            title: group.label,
            credits,
            kind: 'electiva',
            blockLabel: label,
            position: period.position,
          });
        }
        continue;
      }

      for (const item of group.items) {
        if (item.isCandidate || item.status !== 'pending') continue;
        if (completed.has(item.code) || seen.has(item.code)) continue;
        seen.add(item.code);
        const units = [item.units, plan?.courses?.[item.code]?.units].find(
          (value) => value != null && Number.isFinite(value) && value >= 0
        );
        out.push({
          code: item.code,
          title: item.title ?? plan?.courses?.[item.code]?.title ?? item.code,
          credits: units ?? 3,
          kind: 'obligatoria',
          blockLabel: label,
          position: period.position,
        });
      }
    }
  }
  return out;
}

// ── La cadena de prerrequisitos ──────────────────────────────────────────────

/**
 * La longitud de la cadena que cuelga de cada materia pendiente, ella incluida.
 *
 * Es el número que impone el piso: si ICC-104 abre ICC-203, que abre ICC-303,
 * esas tres materias son tres ciclos aunque solo sumen nueve créditos. Solo se
 * miran las materias que TODAVÍA faltan — un prerrequisito ya aprobado no
 * encadena nada.
 */
export function chainLengths(codes: Iterable<string>, plan: PensumPlan | null): Map<string, number> {
  const pending = new Set(codes);
  const lengths = new Map<string, number>();
  if (!plan) {
    for (const code of pending) lengths.set(code, 1);
    return lengths;
  }

  // Sucesores: quién depende de quién, restringido a lo pendiente.
  const successors = new Map<string, string[]>();
  for (const code of pending) successors.set(code, []);
  for (const code of pending) {
    for (const prereq of plan.courses[code]?.prereqs ?? []) {
      const match = equivalents(plan, prereq).find((candidate) => pending.has(candidate));
      if (match && match !== code) successors.get(match)!.push(code);
    }
  }

  // El plan es un DAG, pero un PDF mal parseado o una recodificación circular
  // podrían no serlo. `visiting` corta el ciclo en vez de desbordar la pila.
  const visiting = new Set<string>();
  const depth = (code: string): number => {
    const cached = lengths.get(code);
    if (cached != null) return cached;
    if (visiting.has(code)) return 1;
    visiting.add(code);
    let longest = 0;
    for (const next of successors.get(code) ?? []) longest = Math.max(longest, depth(next));
    visiting.delete(code);
    const value = longest + 1;
    lengths.set(code, value);
    return value;
  };
  for (const code of pending) depth(code);
  return lengths;
}

/** La cadena más larga que queda, reconstruida en orden de cursado. */
function longestChain(
  lengths: Map<string, number>,
  plan: PensumPlan | null,
  titles: Map<string, string>
): Array<{ code: string; title: string }> {
  let head: string | null = null;
  let best = 0;
  // Orden estable por código: dos cadenas de igual largo devuelven siempre la
  // misma, y no la que el Map haya iterado primero.
  for (const code of [...lengths.keys()].sort()) {
    const value = lengths.get(code)!;
    if (value > best) {
      best = value;
      head = code;
    }
  }
  if (!head || best < 2 || !plan) return head && best >= 2 ? [{ code: head, title: titles.get(head) ?? head }] : [];

  const chain = [head];
  let current = head;
  let remaining = best;
  while (remaining > 1) {
    const next = [...lengths.keys()]
      .sort()
      .find(
        (code) =>
          lengths.get(code) === remaining - 1 &&
          (plan.courses[code]?.prereqs ?? []).some((prereq) => equivalents(plan, prereq).includes(current))
      );
    if (!next) break;
    chain.push(next);
    current = next;
    remaining -= 1;
  }
  return chain.map((code) => ({ code, title: titles.get(code) ?? code }));
}

// ── Etiquetas de ciclo ───────────────────────────────────────────────────────

/** "Abril de 2026" + 2 ciclos → "Enero de 2027". null si la etiqueta no ubica. */
export function termLabelAfter(label: string | null, cycles: number): string | null {
  const ordinal = cycleOrdinal(termSortKey(label ?? ''));
  if (ordinal === null) return null;
  const target = ordinal + cycles;
  const year = Math.floor(target / 3);
  const index = ((target % 3) + 3) % 3;
  return `${CYCLE_NAMES[index]} de ${year}`;
}

// ── El planificador ──────────────────────────────────────────────────────────

export type DegreePathInput = {
  requirements: RequirementGroup | null;
  plan: PensumPlan | null;
  /** Lo aprobado, lo que se cursa hoy y los créditos ya acreditados. */
  standing: CourseStanding;
  maxCredits: number;
  /** El ciclo en que arranca la ruta: el próximo a inscribir. */
  startTerm?: string | null;
  /** Red de seguridad contra un pénsum patológico. */
  maxTerms?: number;
};

export function buildDegreePath({
  requirements,
  plan,
  standing,
  maxCredits,
  startTerm = null,
  maxTerms = 30,
}: DegreePathInput): DegreePath {
  const empty = (reason: string, caveats: string[] = []): DegreePath => ({
    available: false,
    reason,
    maxCredits,
    terms: [],
    termsRemaining: 0,
    creditsRemaining: 0,
    coursesRemaining: 0,
    graduationTerm: null,
    binding: 'ninguna',
    chainFloor: 0,
    loadFloor: 0,
    criticalPath: [],
    bottlenecks: [],
    unscheduled: [],
    caveats,
  });

  if (!Number.isFinite(maxCredits) || maxCredits <= 0) {
    return empty('La carga máxima por ciclo tiene que ser mayor que cero.');
  }
  if (!requirements) {
    return empty('Sincronizá tu informe de avance para poder trazar la ruta.');
  }

  const caveats: string[] = [];
  if (!plan) {
    caveats.push(
      'Sin el plan académico oficial de tu carrera no se pueden verificar prerrequisitos: la ruta reparte lo que falta por créditos y el orden real puede ser más largo.'
    );
  } else {
    caveats.push(
      `Prerrequisitos según el plan ${plan.plan}${plan.issuedAt ? ` emitido el ${plan.issuedAt}` : ''}. El portal manda si discrepan.`
    );
  }

  const completed = new Set([...standing.approved, ...standing.inProgress]);
  const pending = pendingFromRequirements(requirements, plan, completed);
  if (!pending.length) {
    return {
      ...empty('No queda nada pendiente en tu pénsum.'),
      available: true,
      reason: null,
      caveats,
    };
  }

  if (standing.inProgress.size > 0) {
    caveats.push(
      `La ruta da por aprobado lo que cursás ahora (${[...standing.inProgress].sort().join(', ')}). Si reprobás alguna, se corre.`
    );
  }
  caveats.push(
    'Asume que cada materia se oferta todos los ciclos y que aprobás todo a la primera. Es el piso, no una promesa.'
  );
  if (pending.some((course) => course.kind === 'electiva')) {
    caveats.push(
      'Las electivas entran como cupos sin materia elegida: ocupan créditos pero no encadenan prerrequisitos, porque cuál tomar lo decidís vos.'
    );
  }

  const byCode = new Map(pending.map((course) => [course.code, course]));
  const titles = new Map(pending.map((course) => [course.code, course.title]));
  const obligatorias = pending.filter((course) => course.kind === 'obligatoria').map((course) => course.code);
  const lengths = chainLengths(obligatorias, plan);

  const creditsRemaining = Math.round(pending.reduce((sum, course) => sum + course.credits, 0) * 10) / 10;
  const chainFloor = Math.max(0, ...lengths.values());
  const loadFloor = Math.ceil(creditsRemaining / maxCredits);

  // Colocar en el tiempo. Cada vuelta es un ciclo: se toman todas las materias
  // ya elegibles, se ordenan por lo que más aprieta y se empaquetan hasta el
  // techo de créditos. Lo que entra pasa a contar como aprobado para la vuelta
  // siguiente, y con eso las compuertas por porcentaje se abren solas.
  const remaining = new Set(byCode.keys());
  const approved = new Set(standing.approved);
  const inProgress = new Set(standing.inProgress);
  let approvedUnits = standing.approvedUnits;
  const terms: DegreePathTerm[] = [];
  const assignedTerm = new Map<string, number>();
  const requiredBy = new Map<string, string>();
  const conditional = new Map<string, string[]>();

  for (let index = 1; remaining.size > 0 && index <= maxTerms; index++) {
    const standingNow: CourseStanding = { approved, inProgress, approvedUnits };

    // Cada candidata con su paquete de co-requisitos: lo que entra o sale junto.
    type Bundle = { lead: PendingCourse; members: PendingCourse[]; credits: number; conditionalOn: string[] };
    const bundles: Bundle[] = [];
    for (const code of remaining) {
      const course = byCode.get(code)!;
      if (course.kind === 'electiva') {
        bundles.push({ lead: course, members: [course], credits: course.credits, conditionalOn: [] });
        continue;
      }
      const closure = coreqClosure(plan, [code]).filter(
        (member) => !approved.has(member) && !inProgress.has(member)
      );
      // Un co-requisito que ya se colocó en un ciclo ANTERIOR no vuelve: el
      // plan pide cursarlos juntos o la teoría después, nunca al revés.
      if (closure.some((member) => assignedTerm.has(member))) continue;
      const members = closure.map(
        (member) =>
          byCode.get(member) ?? {
            code: member,
            title: plan?.courses?.[member]?.title ?? member,
            credits: plan?.courses?.[member]?.units ?? 0,
            kind: 'obligatoria' as const,
            blockLabel: course.blockLabel,
            position: course.position,
          }
      );
      const verdict = evaluate(plan, code, standingNow, members.map((member) => member.code));
      if (!verdict.eligible) continue;
      bundles.push({
        lead: course,
        members,
        credits: members.reduce((sum, member) => sum + member.credits, 0),
        conditionalOn: verdict.conditionalOn,
      });
    }

    // El orden ES la ruta. Primero lo que encadena más (atrasar eso atrasa la
    // graduación), después lo más viejo del pénsum. Las electivas van al final:
    // no encadenan nada, así que solo deben ocupar el espacio que sobre.
    bundles.sort((a, b) => {
      const aElective = a.lead.kind === 'electiva' ? 1 : 0;
      const bElective = b.lead.kind === 'electiva' ? 1 : 0;
      if (aElective !== bElective) return aElective - bElective;
      const aChain = lengths.get(a.lead.code) ?? 1;
      const bChain = lengths.get(b.lead.code) ?? 1;
      if (aChain !== bChain) return bChain - aChain;
      if (a.lead.position !== b.lead.position) return a.lead.position - b.lead.position;
      return a.lead.code.localeCompare(b.lead.code);
    });

    const placed: DegreePathCourse[] = [];
    let credits = 0;
    for (const bundle of bundles) {
      if (bundle.members.some((member) => !remaining.has(member.code) && assignedTerm.has(member.code))) continue;
      if (credits + bundle.credits > maxCredits) continue;
      for (const member of bundle.members) {
        if (assignedTerm.has(member.code)) continue;
        assignedTerm.set(member.code, index);
        if (member.code !== bundle.lead.code) requiredBy.set(member.code, bundle.lead.code);
        if (member.code === bundle.lead.code && bundle.conditionalOn.length) {
          conditional.set(member.code, bundle.conditionalOn);
        }
        placed.push({
          code: member.code,
          title: member.title,
          credits: member.credits,
          kind: member.kind,
          blockLabel: member.blockLabel,
          unlocks: member.kind === 'obligatoria' ? unlockCount(plan, member.code) : 0,
          chainLength: lengths.get(member.code) ?? 1,
          critical: false, // se resuelve abajo, cuando se conoce el total
          requiredBy: member.code === bundle.lead.code ? null : bundle.lead.code,
          conditionalOn: member.code === bundle.lead.code ? bundle.conditionalOn : [],
        });
        remaining.delete(member.code);
      }
      credits += bundle.credits;
    }

    // Nada entró y todavía falta: la ruta se traba acá. Puede pasar con un
    // prerrequisito que el plan exige y el pénsum del estudiante no lista, o
    // con una compuerta que sus créditos nunca alcanzan.
    if (!placed.length) break;

    terms.push({
      index,
      label: termLabelAfter(startTerm, index - 1),
      credits: Math.round(credits * 10) / 10,
      courses: placed,
    });
    for (const course of placed) {
      approved.add(course.code);
      approvedUnits += course.credits;
    }
    // Lo que se cursaba al empezar la ruta queda aprobado tras el primer ciclo:
    // de ahí en adelante deja de ser condicional para las vueltas siguientes.
    for (const code of inProgress) approved.add(code);
    inProgress.clear();
  }

  const termsRemaining = terms.length;

  // La holgura: una materia sin holgura es la que fija la fecha. Las electivas
  // nunca lo son — siempre se pueden cambiar por otra candidata del mismo bloque.
  for (const term of terms) {
    for (const course of term.courses) {
      course.critical =
        course.kind === 'obligatoria' && term.index - 1 + course.chainLength === termsRemaining && termsRemaining > 0;
    }
  }

  const unscheduled: DegreePathBlocker[] = [...remaining].map((code) => {
    const course = byCode.get(code)!;
    const verdict = evaluate(plan, code, { approved, inProgress, approvedUnits }, [code]);
    const missing = verdict.blockers
      .filter((blocker) => blocker.kind === 'prereq')
      .map((blocker) => (blocker as { code: string }).code);
    return {
      code,
      title: course.title,
      reason: missing.length
        ? `El plan la traba detrás de ${missing.join(' y ')}, y eso no aparece entre lo que te falta ni entre lo que aprobaste.`
        : 'No se pudo ubicar en ningún ciclo dentro del horizonte calculado.',
      missing,
    };
  });
  if (unscheduled.length) {
    caveats.push(
      `${unscheduled.length} ${unscheduled.length === 1 ? 'materia quedó' : 'materias quedaron'} fuera de la ruta: la fecha estimada no las incluye.`
    );
  }

  const bottlenecks: DegreePathBottleneck[] = terms
    .flatMap((term) => term.courses.map((course) => ({ course, termIndex: term.index })))
    .filter(({ course }) => course.kind === 'obligatoria' && (course.unlocks > 0 || course.chainLength > 1))
    .sort(
      (a, b) =>
        Number(b.course.critical) - Number(a.course.critical) ||
        b.course.chainLength - a.course.chainLength ||
        b.course.unlocks - a.course.unlocks ||
        a.course.code.localeCompare(b.course.code)
    )
    .slice(0, 5)
    .map(({ course, termIndex }) => ({
      code: course.code,
      title: course.title,
      unlocks: course.unlocks,
      chainLength: course.chainLength,
      termIndex,
    }));

  // Cuál de las dos restricciones manda. Es la pregunta que vuelve accionable el
  // número: contra la cadena, subir la carga no adelanta un solo día.
  const binding: DegreePathBinding =
    termsRemaining === 0
      ? 'ninguna'
      : chainFloor >= termsRemaining && loadFloor >= termsRemaining
        ? 'ambas'
        : chainFloor >= termsRemaining
          ? 'prerrequisitos'
          : loadFloor >= termsRemaining
            ? 'carga'
            : 'ambas';

  return {
    available: termsRemaining > 0,
    reason:
      termsRemaining > 0
        ? null
        : 'No se pudo colocar ninguna materia: revisá que tu informe de avance y tu histórico estén sincronizados.',
    maxCredits,
    terms,
    termsRemaining,
    creditsRemaining,
    coursesRemaining: pending.length,
    graduationTerm: termsRemaining > 0 ? termLabelAfter(startTerm, termsRemaining - 1) : null,
    binding,
    chainFloor,
    loadFloor,
    criticalPath: longestChain(lengths, plan, titles),
    bottlenecks,
    unscheduled,
    caveats,
  };
}
