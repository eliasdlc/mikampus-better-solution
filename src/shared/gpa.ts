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
// dice "2.800" donde 402/143 da 2.8112. Para que el número de mikampus no
// contradiga al de micampus, lo que se muestra pasa por acá; el cálculo
// interno (y el delta del what-if) se queda con la precisión completa.
export function formatGpa(gpa: number | null): string {
  if (gpa === null) return '—';
  return (Math.round(gpa * 10) / 10).toFixed(3);
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
