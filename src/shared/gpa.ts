// La aritmética del índice académico de la PUCMM, compartida backend/frontend:
// el sync la usa para resumir el histórico y el simulador what-if de
// /academico la corre en el cliente sobre notas hipotéticas. Una sola
// implementación para que el número proyectado y el real no puedan discrepar.
//
// La escala NO está adivinada: sale de los grade points que el propio portal
// publica por materia (Enero de 2026: A=16/4, B=12/4, C=8/4, D=4/4 créditos),
// y el modelo entero se verifica contra los totales que el portal calcula
// (143 créditos, 402 puntos, 131 aprobados) en test-grades-parser.mjs.

export const GRADE_POINTS: Record<string, number> = { A: 4, B: 3, C: 2, D: 1, F: 0 };

// El estudiante también tiene notas S (satisfactorio), R (retirada) y EXO
// (exonerada por transferencia). Ninguna entra al índice, y no es un detalle
// cosmético: los 8 créditos en R son exactamente la diferencia entre los 151
// créditos cursados y los 143 que el portal cuenta para el GPA. Contarlas
// hundiría el índice con materias que la universidad no cuenta.
export function countsTowardGpa(grade: string | null | undefined): boolean {
  return typeof grade === 'string' && grade.toUpperCase() in GRADE_POINTS;
}

// Aprobada = cuenta para el índice y no es F. La suma da los 131 créditos
// "Passed" del portal.
export function isPassing(grade: string | null | undefined): boolean {
  return countsTowardGpa(grade) && grade!.toUpperCase() !== 'F';
}

// Notas que aprueban la materia sin entrar al índice: S (satisfactorio, la nota
// de los laboratorios) y EXO (exonerada por transferencia).
const APPROVING_OUTSIDE_GPA = new Set(['S', 'EXO']);

// "¿Tengo esta materia aprobada?" es una pregunta DISTINTA de "¿cuenta para mi
// índice?", y confundirlas rompe los prerrequisitos en las dos direcciones:
//
//   · Un laboratorio con S no cuenta para el índice pero SÍ está aprobado, y es
//     prerrequisito de la física del año siguiente.
//   · Una materia con R (retirada) o F no está aprobada, aunque el histórico la
//     liste como cursada. Tratarlas como aprobadas es lo que hacía que el
//     recomendador propusiera Física II a quien todavía debe Física I.
//
// Sin nota todavía (null) no es aprobada: es una materia en curso.
export function isApproved(grade: string | null | undefined): boolean {
  if (typeof grade !== 'string') return false;
  const value = grade.trim().toUpperCase();
  return isPassing(value) || APPROVING_OUTSIDE_GPA.has(value);
}

export type GradedCourse = {
  grade: string | null;
  units: number | null;
  status: string;
};

export type GpaSummary = {
  unitsTowardGpa: number;
  gradePoints: number;
  unitsPassed: number;
  unitsInProgress: number;
  // null y no 0 cuando no hay ni un crédito calificado: un estudiante sin
  // notas no tiene índice 0.00, no tiene índice.
  gpa: number | null;
};

export function summarizeGrades(courses: GradedCourse[]): GpaSummary {
  let unitsTowardGpa = 0;
  let gradePoints = 0;
  let unitsPassed = 0;
  let unitsInProgress = 0;

  for (const c of courses) {
    const units = c.units ?? 0;
    if (c.status === 'in_progress') {
      unitsInProgress += units;
      continue;
    }
    // Las transferidas (EXO) llegan con 0 créditos y sin nota de escala: no
    // mueven nada, pero se filtran explícito para que no dependa de eso.
    if (c.status !== 'taken' || !countsTowardGpa(c.grade)) continue;
    unitsTowardGpa += units;
    gradePoints += units * GRADE_POINTS[c.grade!.toUpperCase()];
    if (isPassing(c.grade)) unitsPassed += units;
  }

  return {
    unitsTowardGpa,
    gradePoints,
    unitsPassed,
    unitsInProgress,
    gpa: unitsTowardGpa > 0 ? gradePoints / unitsTowardGpa : null,
  };
}

// El portal publica el índice con un decimal de precisión y tres de adorno:
// dice "2.800" donde 402/143 da 2.8112. El índice oficial del estudiante es
// ese, así que todo lo que se muestre pasa por acá — mikampus no puede
// contradecir a micampus sobre su propio índice.
//
// Que redondea (y no trunca) está verificado, no asumido: el acumulado no
// alcanzaba para distinguirlo (2.8112 cae en 2.8 de las dos formas), así que
// se fue a buscar un término que sí: Enero de 2025 da 40/15 = 2.6667 y el
// portal lo publica como 2.700, no 2.600 (fixtures/recon-grades-enero2025.html).
export function roundGpa(gpa: number): number {
  return Math.round(gpa * 10) / 10;
}

export function formatGpa(gpa: number | null): string {
  if (gpa === null) return '—';
  return roundGpa(gpa).toFixed(3);
}

// ── Proyecciones (Fase 10, §12.7) ────────────────────────────────────────────
// El índice final se modela sobre lo que falta del pénsum. Todo sale de dos
// hechos ya verificados: la aritmética de summarizeGrades reproduce al portal, y
// PUCMM PROMEDIA los intentos de una repetida (no reemplaza) — comprobado con
// IIS-223 (F→D, ambos cuentan) contra los totales del portal. Por eso repetir no
// es una palanca especial: cada crédito futuro entra al promedio igual que uno
// nuevo, y proyectar sobre "créditos faltantes" es honesto sin caso aparte.
//
//   final(g) = (puntos + faltantes·g) / (créditosAlÍndice + faltantes)
//
// donde g es el promedio de grade points (0–4) que asumís en lo que falta.

export type GpaLike = {
  gradePoints: number;
  unitsTowardGpa: number;
};

// El índice acumulado que tendrías si en los `remainingCredits` que te faltan
// sacaras un promedio de `gradePoint` (0–4). Exacto, sin redondear: quien
// redondea a la precisión del portal es la capa de presentación (roundGpa).
export function projectGpa(summary: GpaLike, remainingCredits: number, gradePoint: number): number | null {
  const units = summary.unitsTowardGpa + Math.max(0, remainingCredits);
  if (units <= 0) return null;
  return (summary.gradePoints + Math.max(0, remainingCredits) * gradePoint) / units;
}

export type GpaProjection = {
  remainingCredits: number;
  current: number | null;
  // El abanico honesto, redondeado a la precisión del portal (un decimal).
  best: number | null; // todo A de aquí en adelante
  maintain: number | null; // mantenés tu promedio histórico
  floor: number | null; // todo C (piso razonable, no todo F)
};

// El abanico best/maintain/floor. "maintain" usa el índice actual como grade
// point asumido: es un punto fijo (final == actual), y por eso responde "si
// seguís como vas, terminás igual" sin que sea coincidencia.
export function projectFinalGpa(summary: GpaLike, remainingCredits: number): GpaProjection {
  const current = summary.unitsTowardGpa > 0 ? summary.gradePoints / summary.unitsTowardGpa : null;
  const round = (v: number | null) => (v === null ? null : roundGpa(v));
  return {
    remainingCredits: Math.max(0, remainingCredits),
    current: round(current),
    best: round(projectGpa(summary, remainingCredits, GRADE_POINTS.A)),
    maintain: current === null ? null : round(projectGpa(summary, remainingCredits, current)),
    floor: round(projectGpa(summary, remainingCredits, GRADE_POINTS.C)),
  };
}

export type GoalVerdict =
  | 'met' // el índice actual ya alcanza la meta y no hay créditos que la muevan
  | 'secured' // llegás aunque saques F en todo lo que falta
  | 'reachable' // llegás con un promedio alcanzable en lo restante
  | 'tight' // llegás pero exige casi todo A
  | 'unreachable'; // ni con todo A en lo que falta

export type GoalFeasibility = {
  verdict: GoalVerdict;
  // El promedio de grade points (0–4) que exige lo que falta para dar la meta.
  // null cuando no hay créditos restantes (nada que puedas hacer para cambiarlo).
  requiredAverage: number | null;
  target: number;
};

// Qué exige una meta de índice sobre los créditos que faltan, y si es posible.
// El veredicto "unreachable" solo se emite porque la política de repetición está
// verificada (§12.7): sabemos que no hay un truco de repetir que lo salve.
export function feasibilityForGoal(summary: GpaLike, remainingCredits: number, target: number): GoalFeasibility {
  const remaining = Math.max(0, remainingCredits);
  const current = summary.unitsTowardGpa > 0 ? summary.gradePoints / summary.unitsTowardGpa : null;

  // Sin créditos por delante, la meta ya está decidida: se compara contra el
  // índice tal como lo publica el portal (redondeado), no el exacto.
  if (remaining === 0) {
    const met = current !== null && roundGpa(current) >= target - 1e-9;
    return { verdict: met ? 'met' : 'unreachable', requiredAverage: null, target };
  }

  const requiredAverage = (target * (summary.unitsTowardGpa + remaining) - summary.gradePoints) / remaining;

  let verdict: GoalVerdict;
  if (requiredAverage <= 0) verdict = 'secured';
  else if (requiredAverage > GRADE_POINTS.A + 1e-9) verdict = 'unreachable';
  else if (requiredAverage > 3.7) verdict = 'tight';
  else verdict = 'reachable';

  return { verdict, requiredAverage, target };
}

// ── Términos ────────────────────────────────────────────────────────────────
// El portal nombra los términos en español ("Enero de 2026") y los lista sin
// orden útil. Ordenarlos por texto pone Abril antes que Enero y Septiembre de
// 2023 después de Enero de 2026: el sparkline de evolución del índice saldría
// dibujado al azar.

const MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

// Los nombres vienen acentuados ("Septiembre") y a veces en mayúsculas: se
// comparan sin acentos para no tener que escribir cada mes dos veces.
function normalize(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// "Enero de 2026" → "2026-01", que ordena bien como texto. Un término que no
// matchee devuelve null y la UI lo manda al final en vez de inventarle fecha.
export function termSortKey(label: string): string | null {
  const m = normalize(label).match(/([a-z]+)\s+de\s+(\d{4})/);
  if (!m) return null;
  const month = MONTHS[m[1]];
  if (!month) return null;
  return `${m[2]}-${String(month).padStart(2, '0')}`;
}

export function sortTermLabels(labels: string[]): string[] {
  return [...labels].sort((a, b) => {
    const ka = termSortKey(a);
    const kb = termSortKey(b);
    if (ka === null) return kb === null ? a.localeCompare(b) : 1;
    if (kb === null) return -1;
    return ka.localeCompare(kb);
  });
}
