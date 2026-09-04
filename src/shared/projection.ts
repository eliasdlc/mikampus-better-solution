// Proyecciones de índice auditables (P5).
//
// El problema no era la fórmula —la de gpa.ts reproduce al portal— sino qué se
// proyectaba. Metas mezclaba materias en curso de ciclos distintos y solo
// mostraba el horizonte final, así que "tu mejor caso" incluía créditos de un
// cuatrimestre que todavía no empezaba. Y proyectaba siempre, incluso cuando el
// acumulado reconstruido no cuadraba con el que publica PeopleSoft.
//
// Acá hay tres reglas:
//
//   1. Dos horizontes separados. "Al cerrar este ciclo" solo cuenta los
//      créditos EN CURSO del ciclo elegido. "Hasta graduarte" cuenta lo
//      pendiente del advisement. Sumarlos era el bug.
//   2. El baseline es el acumulado que publica PeopleSoft. El nuestro es
//      auditoría, no verdad.
//   3. Si los dos no reconcilian dentro de la precisión oficial, NO se proyecta.
//      Se muestra la diferencia y se explica. Un número plausible y falso es
//      peor que ningún número.

import { GRADE_POINTS, roundGpa, type GpaLike } from './gpa.ts';

// El portal publica el índice con un decimal real ("2.800"): dos acumulados que
// difieren menos que eso son el mismo número visto con distinta precisión.
export const OFFICIAL_PRECISION = 0.05;

export type OfficialTotals = {
  gpa: number | null;
  unitsTowardGpa: number | null;
  gradePoints: number | null;
};

export type ReconciliationStatus = 'match' | 'mismatch' | 'unknown';

export type Reconciliation = {
  status: ReconciliationStatus;
  official: number | null;
  reconstructed: number | null;
  /** Diferencia absoluta, o null si falta alguno de los dos. */
  difference: number | null;
  precision: number;
  explanation: string;
};

/**
 * Compara el acumulado publicado por PeopleSoft con el que reconstruimos.
 *
 * `unknown` no es un fallo: es no haber sincronizado todavía. Lo que sí es
 * bloqueante es `mismatch`, porque significa que una de las dos cuentas está
 * usando una regla distinta —muy probablemente la de repetidas— y proyectar
 * sobre cualquiera de las dos sería inventar precisión que no tenemos.
 */
export function reconcileGpa(official: OfficialTotals | null, reconstructed: GpaLike | null): Reconciliation {
  const mine =
    reconstructed && reconstructed.unitsTowardGpa > 0
      ? reconstructed.gradePoints / reconstructed.unitsTowardGpa
      : null;
  const theirs = official?.gpa ?? null;

  if (theirs === null || mine === null) {
    return {
      status: 'unknown',
      official: theirs,
      reconstructed: mine,
      difference: null,
      precision: OFFICIAL_PRECISION,
      explanation:
        theirs === null
          ? 'Todavía no leímos el acumulado que publica PeopleSoft. Actualizá tus notas para poder proyectar.'
          : 'Todavía no hay materias calificadas suficientes para reconstruir tu acumulado.',
    };
  }

  const difference = Math.abs(theirs - mine);
  if (difference <= OFFICIAL_PRECISION) {
    return {
      status: 'match',
      official: theirs,
      reconstructed: mine,
      difference,
      precision: OFFICIAL_PRECISION,
      explanation: 'Nuestro cálculo por materias coincide con el acumulado que publica PeopleSoft.',
    };
  }

  return {
    status: 'mismatch',
    official: theirs,
    reconstructed: mine,
    difference,
    precision: OFFICIAL_PRECISION,
    explanation:
      `PeopleSoft publica ${theirs.toFixed(3)} y nuestro cálculo por materias da ${mine.toFixed(3)}. ` +
      'Mientras no coincidan no proyectamos: la diferencia suele venir de cómo se cuentan las materias repetidas, ' +
      'y elegir una de las dos reglas por nuestra cuenta te daría una cifra que parece confirmada y no lo está.',
  };
}

export type Horizon = {
  id: 'current-term' | 'graduation';
  label: string;
  /** Índice de partida: siempre el que publica PeopleSoft. */
  baseline: number | null;
  baselineUnits: number;
  /** Créditos que este horizonte pone en juego. */
  futureCredits: number;
  /** Promedio de grade points asumido (0–4) para esos créditos. */
  assumedAverage: number;
  /** El resultado sin redondear, a dos decimales de presentación. */
  exact: number | null;
  /** Cómo lo publicaría PeopleSoft (un decimal real). */
  asPublished: number | null;
};

/**
 * Un escenario, nunca una promesa: "si en estos N créditos sacás un promedio g,
 * tu acumulado queda en X".
 *
 * El baseline entra como par (índice, créditos) del portal y no como nuestros
 * puntos acumulados: así el número parte de la verdad oficial aunque nuestra
 * reconstrucción tenga otra política de repetidas.
 */
export function projectHorizon({
  id,
  label,
  baseline,
  baselineUnits,
  futureCredits,
  assumedAverage,
}: {
  id: Horizon['id'];
  label: string;
  baseline: number | null;
  baselineUnits: number;
  futureCredits: number;
  assumedAverage: number;
}): Horizon {
  const credits = Math.max(0, futureCredits);
  const units = baselineUnits + credits;
  const exact =
    baseline === null || units <= 0 ? null : (baseline * baselineUnits + credits * assumedAverage) / units;

  return {
    id,
    label,
    baseline,
    baselineUnits,
    futureCredits: credits,
    assumedAverage,
    exact: exact === null ? null : Math.round(exact * 100) / 100,
    asPublished: exact === null ? null : roundGpa(exact),
  };
}

export type HorizonScenarios = {
  best: Horizon;
  maintain: Horizon;
  floor: Horizon;
};

/** El abanico de un horizonte: todo A, mantener el ritmo, o todo C. */
export function scenariosFor(
  id: Horizon['id'],
  label: string,
  { baseline, baselineUnits, futureCredits }: { baseline: number | null; baselineUnits: number; futureCredits: number }
): HorizonScenarios {
  const make = (assumedAverage: number) =>
    projectHorizon({ id, label, baseline, baselineUnits, futureCredits, assumedAverage });
  return {
    best: make(GRADE_POINTS.A),
    // "Mantener" usa el propio baseline como promedio asumido: es un punto fijo
    // y por eso responde "si seguís como vas, terminás igual" sin coincidencia.
    maintain: make(baseline ?? GRADE_POINTS.C),
    floor: make(GRADE_POINTS.C),
  };
}

export type InProgressCourse = {
  term: string | null;
  units: number | null;
  status: string;
};

/**
 * Los créditos en curso de UN ciclo. La firma pide el ciclo a propósito: sumar
 * "todo lo en curso" mezclaba materias de cuatrimestres distintos y era
 * exactamente lo que inflaba el mejor caso del ciclo actual.
 */
export function creditsInProgressFor(courses: InProgressCourse[], term: string | null): number {
  if (!term) return 0;
  return courses
    .filter((course) => course.status === 'in_progress' && course.term === term)
    .reduce((total, course) => total + (course.units ?? 0), 0);
}

export type ProjectionReport = {
  reconciliation: Reconciliation;
  /** null cuando la reconciliación no permite proyectar con confianza. */
  currentTerm: HorizonScenarios | null;
  graduation: HorizonScenarios | null;
  formula: string;
};

export const FORMULA = 'índice = (índice actual × créditos al índice + créditos futuros × promedio asumido) ÷ (créditos al índice + créditos futuros)';

/**
 * El informe completo que consume la pantalla de Metas.
 *
 * Si la reconciliación falla, los dos horizontes vuelven en null. La UI no
 * tiene que acordarse de esconder el número: no existe.
 */
export function buildProjection({
  official,
  reconstructed,
  currentTermCredits,
  remainingCredits,
  currentTermLabel,
}: {
  official: OfficialTotals | null;
  reconstructed: GpaLike | null;
  currentTermCredits: number;
  remainingCredits: number;
  currentTermLabel: string | null;
}): ProjectionReport {
  const reconciliation = reconcileGpa(official, reconstructed);
  const canProject = reconciliation.status === 'match';
  const baseline = official?.gpa ?? null;
  const baselineUnits = official?.unitsTowardGpa ?? reconstructed?.unitsTowardGpa ?? 0;

  return {
    reconciliation,
    currentTerm: canProject
      ? scenariosFor('current-term', currentTermLabel ? `Al cerrar ${currentTermLabel}` : 'Al cerrar este ciclo', {
          baseline,
          baselineUnits,
          futureCredits: currentTermCredits,
        })
      : null,
    graduation: canProject
      ? scenariosFor('graduation', 'Hasta graduarte', {
          baseline,
          baselineUnits,
          futureCredits: remainingCredits,
        })
      : null,
    formula: FORMULA,
  };
}

// ── Serie de trayectoria (P5 §5) ────────────────────────────────────────────
// El acumulado DESPUÉS de cada ciclo, que es lo que la gráfica dibuja como
// serie principal. No es el índice del período: es cómo quedó tu récord tras
// cerrar ese cuatrimestre, y es la línea que de verdad cuenta la historia.

export type TermPoint = {
  term: string;
  sortKey: string | null;
  gpa: number | null;
  unitsTowardGpa: number;
  gradePoints: number;
};

export type TrajectoryPoint = {
  term: string;
  /** Índice del período. Puede ser null si el ciclo no dejó créditos al índice. */
  termGpa: number | null;
  /** Acumulado tras cerrar ese ciclo. */
  cumulative: number;
  unitsTowardGpa: number;
  cumulativeUnits: number;
};

export function cumulativeSeries(terms: TermPoint[]): TrajectoryPoint[] {
  const chronological = terms
    .filter((term) => term.unitsTowardGpa > 0)
    .slice()
    .sort((a, b) => (a.sortKey ?? '').localeCompare(b.sortKey ?? ''));

  let units = 0;
  let points = 0;
  const series: TrajectoryPoint[] = [];
  for (const term of chronological) {
    units += term.unitsTowardGpa;
    points += term.gradePoints;
    series.push({
      term: term.term,
      termGpa: term.gpa,
      cumulative: points / units,
      unitsTowardGpa: term.unitsTowardGpa,
      cumulativeUnits: units,
    });
  }
  return series;
}
