import { termSortKey } from './gpa.ts';
import type { RequirementGroup, RequirementItem } from './schemas.ts';

// La trayectoria de carrera (Fase 8): puro y testeado, cero red. Con el árbol de
// requisitos (que ya trae los totales del pénsum) y la cohorte cruza dos cosas
// que hasta ahora vivían separadas —dónde te pone el pénsum y cuánto tiempo
// llevás cursando— para responder "¿dónde estoy parado?". Ningún número se
// inventa: las cifras del encabezado son las mismas que publica el advisement, y
// el atraso se muestra con su base de cálculo (§14 del plan: es una inferencia).
//
// El calendario de PUCMM son tres ciclos al año (Enero, Abril, Septiembre). Un
// ciclo es la unidad de tiempo de la carrera: nominalmente, un período del
// pénsum por ciclo.

// "YYYY-MM" → un entero que ordena y resta ciclos. Los tres ciclos del año son
// meses 01/04/09; su índice dentro del año es 0/1/2. Un sortKey que no sea de
// los tres ciclos (no debería pasar en etiquetas reales) devuelve null.
export function cycleOrdinal(sortKey: string | null): number | null {
  if (!sortKey) return null;
  const m = sortKey.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const idx = { '01': 0, '04': 1, '09': 2 }[m[2]];
  if (idx === undefined) return null;
  return year * 3 + idx;
}

// Cuántos ciclos llevás cursando entre dos etiquetas de término, inclusive: de
// "Septiembre de 2023" a "Abril de 2026" son 9 ciclos (contando ambos extremos).
// null si alguna etiqueta no ubica en el calendario.
export function cyclesBetween(fromLabel: string | null, toLabel: string | null): number | null {
  const from = cycleOrdinal(termSortKey(fromLabel ?? ''));
  const to = cycleOrdinal(termSortKey(toLabel ?? ''));
  if (from === null || to === null) return null;
  return to - from + 1;
}

export type CareerPosition = {
  year: number | null;
  period: number | null;
  index: number; // 1-based entre todos los períodos, del bloque donde estás parado
  total: number; // total de períodos del pénsum
  done: boolean; // carrera completa: no queda período sin satisfacer
};

// Un slot de electiva sin cerrar dentro de un bloque futuro. No listamos las
// candidatas acá (el Avance ya lo hace); solo cuántas opciones hay.
export type ElectiveSlot = {
  label: string;
  options: number;
};

// Un período del pénsum todavía sin cerrar, como nodo del futuro de la línea de
// tiempo. Ordenados por posición del documento (la secuencia real de la carrera).
export type FutureBlock = {
  id: number;
  year: number | null;
  period: number | null;
  index: number; // 1-based entre todos los períodos
  creditsNeeded: number | null;
  pending: RequirementItem[]; // obligatorias que faltan
  electives: ElectiveSlot[]; // slots de electiva sin cerrar
};

export type CareerDelay = {
  cohortLabel: string | null;
  currentLabel: string | null;
  elapsedCycles: number | null; // ciclos que llevás cursando, inclusive
  satisfiedPeriods: number;
  totalPeriods: number;
  curriculumPeriodsPerYear: number | null;
  // El bloque sin cerrar más viejo: el hecho concreto y verificable del atraso.
  oldest: {
    year: number | null;
    period: number | null;
    index: number;
    pendingCount: number; // obligatorias que faltan en ese bloque
  } | null;
  // Cuántos ciclos hace que ese bloque debió cerrarse, según el ritmo nominal
  // (un período por ciclo desde la cohorte). Es la inferencia; la UI la muestra
  // con su base. null si no se puede fechar (sin cohorte o sin ciclo actual).
  behindCycles: number | null;
};

export type CareerSummary = {
  position: CareerPosition;
  credits: { taken: number | null; required: number | null; needed: number | null };
  coursesNeeded: number | null;
  cyclesLeft: number; // períodos sin satisfacer: nominalmente, un ciclo cada uno
  delay: CareerDelay;
};

// Los períodos del pénsum, en orden de documento (la secuencia real de la
// carrera aunque otra etiqueta los nombre distinto).
function periodsOf(root: RequirementGroup): RequirementGroup[] {
  return root.children.filter((g) => g.kind === 'periodo').sort((a, b) => a.position - b.position);
}

// Cadencia declarada por el propio documento: cuántos "Período N" hay por
// año. No se hardcodea a los tres ciclos del calendario. Si los años del
// fixture discrepan, null obliga a conservar la aritmética más conservadora.
export function curriculumPeriodsPerYear(root: RequirementGroup): number | null {
  const counts = new Map<number, Set<number>>();
  for (const group of periodsOf(root)) {
    if (group.year == null || group.period == null) continue;
    if (!counts.has(group.year)) counts.set(group.year, new Set());
    counts.get(group.year)!.add(group.period);
  }
  const values = [...counts.values()].map((periods) => periods.size).filter((count) => count > 0);
  if (!values.length || !values.every((count) => count === values[0])) return null;
  return values[0];
}

// Las obligatorias que faltan en un período: los items pendientes de sus grupos
// de "Cursos Obligatorios". Una candidata de electiva no cuenta (es opción, no
// deuda), y por eso solo miramos los grupos obligatorios.
function pendingObligatorias(periodo: RequirementGroup): RequirementItem[] {
  return periodo.children
    .filter((g) => g.kind === 'obligatorios')
    .flatMap((g) => g.items)
    .filter((it) => it.status === 'pending');
}

function electiveSlots(periodo: RequirementGroup): ElectiveSlot[] {
  return periodo.children
    .filter((g) => g.kind === 'electiva' && !g.satisfied)
    .map((g) => ({ label: g.label, options: g.items.length }));
}

// El encabezado de la trayectoria: dónde te pone el pénsum y cuánto atraso hay.
export function careerSummary(
  root: RequirementGroup,
  opts: { cohortStartTerm?: string | null; currentTermLabel?: string | null } = {}
): CareerSummary {
  const periodos = periodsOf(root);
  const total = periodos.length;
  const satisfiedPeriods = periodos.filter((p) => p.satisfied).length;

  // Donde estás parado = el bloque sin cerrar más viejo. Es el frente de la
  // carrera: lo más viejo que todavía te debe el pénsum. Si no queda ninguno,
  // la carrera está completa y la posición apunta al último bloque.
  const oldestUnsatisfied = periodos.find((p) => !p.satisfied) ?? null;
  const positionGroup = oldestUnsatisfied ?? periodos[total - 1] ?? null;
  const positionIndex = positionGroup ? periodos.indexOf(positionGroup) + 1 : 0;

  const elapsedCycles = cyclesBetween(opts.cohortStartTerm ?? null, opts.currentTermLabel ?? null);
  const cadence = curriculumPeriodsPerYear(root);

  let oldest: CareerDelay['oldest'] = null;
  let behindCycles: number | null = null;
  if (oldestUnsatisfied) {
    const index = periodos.indexOf(oldestUnsatisfied) + 1;
    oldest = {
      year: oldestUnsatisfied.year,
      period: oldestUnsatisfied.period,
      index,
      pendingCount: pendingObligatorias(oldestUnsatisfied).length,
    };
    // Ritmo nominal: el período i se cierra en el i-ésimo ciclo. Si llevás más
    // ciclos que eso y sigue abierto, ese es el atraso medido de ese bloque.
    if (elapsedCycles !== null) {
      const expectedPeriod = cadence ? Math.ceil((elapsedCycles * cadence) / 3) : elapsedCycles;
      const behindPeriods = Math.max(0, expectedPeriod - index);
      behindCycles = cadence ? Math.ceil((behindPeriods * 3) / cadence) : behindPeriods;
    }
  }

  return {
    position: {
      year: positionGroup?.year ?? null,
      period: positionGroup?.period ?? null,
      index: positionIndex,
      total,
      done: oldestUnsatisfied === null,
    },
    credits: {
      taken: root.units.taken,
      required: root.units.required,
      needed: root.units.needed,
    },
    coursesNeeded: root.courses.needed,
    cyclesLeft: periodos.filter((p) => !p.satisfied).length,
    delay: {
      cohortLabel: opts.cohortStartTerm ?? null,
      currentLabel: opts.currentTermLabel ?? null,
      elapsedCycles,
      satisfiedPeriods,
      totalPeriods: total,
      curriculumPeriodsPerYear: cadence,
      oldest,
      behindCycles,
    },
  };
}

// Los bloques del futuro: los períodos sin cerrar, en orden, con lo que falta de
// cada uno. Alimenta la parte "futuro" de la línea de tiempo.
export function futureBlocks(root: RequirementGroup): FutureBlock[] {
  const periodos = periodsOf(root);
  return periodos
    .map((p, i) => ({ p, index: i + 1 }))
    .filter(({ p }) => !p.satisfied)
    .map(({ p, index }) => ({
      id: p.id,
      year: p.year,
      period: p.period,
      index,
      creditsNeeded: p.units.needed,
      pending: pendingObligatorias(p),
      electives: electiveSlots(p),
    }));
}
