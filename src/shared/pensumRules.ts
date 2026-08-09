import { splitCourseCode, courseCodeToString } from './courseCode.ts';

// El plan académico oficial, tal como lo emite la Dirección del Registro.
//
// Hasta acá la app sabía QUÉ le falta al estudiante (eso lo da el informe de
// avance del portal) pero no en qué ORDEN puede tomarlo: ni el advisement, ni
// el Browse Catalog, ni el Class Search publican prerrequisitos. El resultado
// era un recomendador que proponía materias imposibles con toda seguridad.
//
// Los prerrequisitos solo existen públicamente en el PDF del plan académico
// (scripts/sync-pensum-rules.mjs lo baja y regenera src/shared/pensum/*.json).
// Este módulo es el parser puro de ese PDF y el modelo que sale de él: recibe
// posiciones de texto, no un PDF, para poder probarse contra un fixture.
//
// Regla de oro del modelo: **la ausencia de una regla nunca bloquea**. El PDF
// es una foto fechada y la universidad mueve códigos entre versiones (el plan
// de 2024 dice CN-112 donde el informe de un estudiante de 2023 dice ESG-112).
// Una materia sin regla conocida se considera cursable; solo bloquea un
// prerrequisito explícito que no está aprobado.

export type PensumCourseRule = {
  /** Canónico ("ICC-101", "FIS-1FIS139"), la llave del resto de la app. */
  code: string;
  /** El ID de catálogo interno de PUCMM ("017095"). Rastro a la fuente. */
  portalId: string;
  title: string;
  theory: number;
  practice: number;
  /** Unidades (créditos). Los laboratorios de física valen 0 y eso es real. */
  units: number;
  year: number;
  period: number;
  /** Si vino de un bloque de electiva, y de cuál (el encabezado tal cual). */
  electiveOf: string | null;
  prereqs: string[];
  coreqs: string[];
};

/** Una regla que el PDF expresa en prosa, no en la tabla. */
export type PensumGateRule = {
  code: string;
  /** Fracción de las unidades del plan que hay que tener aprobada. */
  minApprovedRatio: number;
  text: string;
};

export type PensumPlan = {
  plan: string;
  career: string | null;
  issuedAt: string | null;
  totalUnits: number | null;
  periods: Array<{ year: number; period: number; totalUnits: number | null }>;
  courses: Record<string, PensumCourseRule>;
  gates: PensumGateRule[];
  notes: string[];
  /** De dónde salió el archivo. Lo escribe el script de sync, no el parser. */
  source?: { url: string; fetchedAt: string };
  /**
   * Código del plan → códigos que la universidad usó para la MISMA materia en
   * otras versiones. No sale del PDF (ningún documento las declara): se
   * mantiene a mano y sobrevive a regenerar las reglas.
   */
  aliases?: Record<string, string[]>;
};

/** Un fragmento de texto con su posición, como lo devuelve cualquier lector de PDF. */
export type TextItem = { page: number; x: number; y: number; text: string };

// Las dos columnas de requisitos del reporte. En el texto plano se confunden:
// una fila con un solo código no dice si es previo o adicional, y eso invierte
// el significado (ICC-101 lleva MAT-119 de co-requisito, no de prerrequisito:
// se cursan el mismo período). La posición X sí lo dice sin ambigüedad.
const PREREQ_COLUMN_X = 334;
const COREQ_COLUMN_X = 449; // punto medio entre el fin de "RequisitosPrevios" y el inicio de "RequisitosAdicionales"

const PERIOD_RE = /AÑO(\d+)PERÍODO(\d+)$/;
const COURSE_RE = /^(\d{5,6})\s+(\S+)\s+(.+?)\s+(\d+)\s+(\d+)\s+(\d+)$/;
const ELECTIVE_RE = /^\*(.+?)\.?\s*CURSOSMÍNIMOS/;
const TOTAL_RE = /^Total\s+Unidades:\s*(\d+)/;
const GENERAL_TOTAL_RE = /^Total\s+General\s+de\s+Unidades:\s*(\d+)/;
const GATE_RE = /^([A-Z]{2,4}-\d+)\s*sólopuedensercursadasluegodehaberaprobadoel(\d+)%/i;
const PLAN_RE = /PLAN\s+ACAD[ÉE]MICO:\s*(\S+)\s*-\s*CARRERA\s+DE\s+(.+)$/i;
const ISSUED_RE = /Fecha:\s*(\d{2})\/(\d{2})\/(\d{4})/;

type Line = { page: number; y: number; full: string; left: string; prereq: string; coreq: string };

/**
 * Agrupa los fragmentos sueltos del PDF en líneas, conservando por separado el
 * texto de cada columna de requisitos.
 */
export function toLines(items: TextItem[]): Line[] {
  const buckets = new Map<string, TextItem[]>();
  for (const item of items) {
    if (!item.text.trim()) continue;
    // Redondear la Y junta los fragmentos de una misma fila aunque el PDF los
    // emita con una décima de diferencia.
    const key = `${item.page}:${Math.round(item.y)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(item);
  }

  const lines: Line[] = [];
  for (const [key, group] of buckets) {
    const [page, y] = key.split(':').map(Number);
    const sorted = [...group].sort((a, b) => a.x - b.x);
    const join = (list: TextItem[]) => list.map((i) => i.text).join(' ').replace(/\s+/g, ' ').trim();
    lines.push({
      page,
      y,
      full: join(sorted),
      left: join(sorted.filter((i) => i.x < PREREQ_COLUMN_X - 2)),
      prereq: join(sorted.filter((i) => i.x >= PREREQ_COLUMN_X - 2 && i.x < COREQ_COLUMN_X)),
      coreq: join(sorted.filter((i) => i.x >= COREQ_COLUMN_X)),
    });
  }
  // El PDF no garantiza orden de emisión: página y luego Y descendente (el
  // origen de coordenadas del PDF está abajo).
  return lines.sort((a, b) => a.page - b.page || b.y - a.y);
}

/** "ICC101" / "1FIS139" → "ICC-101" / "FIS-1FIS139". Devuelve null si no parsea. */
export function canonical(raw: string): string | null {
  const code = splitCourseCode(raw.replace(/[.,;]+$/, ''));
  return code ? courseCodeToString(code) : null;
}

function codeList(cell: string): string[] {
  if (!cell) return [];
  return [
    ...new Set(
      cell
        .split(/[,\s]+/)
        .map((token) => token.trim())
        .filter(Boolean)
        .map(canonical)
        .filter((code): code is string => Boolean(code))
    ),
  ];
}

/**
 * Convierte el reporte del plan académico en reglas. `items` viene de un lector
 * de PDF; el parser no sabe de PDFs, lo que lo hace probable contra un fixture.
 */
export function parsePensumPlan(items: TextItem[]): PensumPlan {
  const lines = toLines(items);

  const plan: PensumPlan = {
    plan: 'desconocido',
    career: null,
    issuedAt: null,
    totalUnits: null,
    periods: [],
    courses: {},
    gates: [],
    notes: [],
  };

  let year: number | null = null;
  let period: number | null = null;
  let elective: string | null = null;
  // La última materia leída: las filas del PDF envuelven el nombre a la línea
  // siguiente, y esa continuación hay que devolvérsela a su dueña.
  let last: PensumCourseRule | null = null;

  for (const line of lines) {
    const compact = line.full.replace(/\s+/g, '');

    const planMatch = line.full.match(PLAN_RE);
    if (planMatch) {
      plan.plan = planMatch[1].trim();
      plan.career = planMatch[2].trim();
      continue;
    }
    const issued = line.full.match(ISSUED_RE);
    if (issued) {
      plan.issuedAt = `${issued[3]}-${issued[2]}-${issued[1]}`;
      continue;
    }

    const periodMatch = compact.match(PERIOD_RE);
    if (periodMatch) {
      year = Number(periodMatch[1]);
      period = Number(periodMatch[2]);
      elective = null;
      last = null;
      // El encabezado se repite cuando un período cruza de página.
      if (!plan.periods.some((p) => p.year === year && p.period === period)) {
        plan.periods.push({ year, period, totalUnits: null });
      }
      continue;
    }

    if (/^CURSOSOBLIGATORIOS$/.test(compact)) {
      elective = null;
      last = null;
      continue;
    }

    const electiveMatch = compact.match(ELECTIVE_RE);
    if (electiveMatch) {
      elective = electiveMatch[1];
      last = null;
      continue;
    }

    const generalTotal = line.full.match(GENERAL_TOTAL_RE);
    if (generalTotal) {
      plan.totalUnits = Number(generalTotal[1]);
      last = null;
      continue;
    }
    const total = line.full.match(TOTAL_RE);
    if (total) {
      const current = plan.periods.find((p) => p.year === year && p.period === period);
      if (current) current.totalUnits = Number(total[1]);
      last = null;
      continue;
    }

    const gate = compact.match(GATE_RE);
    if (gate) {
      plan.gates.push({
        code: gate[1],
        minApprovedRatio: Number(gate[2]) / 100,
        text: line.full,
      });
      continue;
    }

    const course = line.left.match(COURSE_RE);
    if (course && year != null && period != null) {
      const code = canonical(course[2]);
      if (!code) continue;
      // Un mismo código aparece en varios bloques (las electivas de ICC se
      // repiten en los tres períodos del año 4). La primera vez manda: es la
      // más temprana en que el plan permite cursarla.
      if (plan.courses[code]) {
        last = null;
        continue;
      }
      const rule: PensumCourseRule = {
        code,
        portalId: course[1],
        title: course[3].trim(),
        theory: Number(course[4]),
        practice: Number(course[5]),
        units: Number(course[6]),
        year,
        period,
        electiveOf: elective,
        prereqs: codeList(line.prereq),
        coreqs: codeList(line.coreq),
      };
      plan.courses[code] = rule;
      last = rule;
      continue;
    }

    // Continuación: el nombre largo que se fue a la línea de abajo, y con él
    // los requisitos que no cupieron en la fila de arriba.
    if (last && line.left && !/^\d{5,6}\s/.test(line.left)) {
      last.title = `${last.title} ${line.left}`.replace(/\s+/g, ' ').trim();
    }
    if (last && (line.prereq || line.coreq)) {
      last.prereqs = [...new Set([...last.prereqs, ...codeList(line.prereq)])];
      last.coreqs = [...new Set([...last.coreqs, ...codeList(line.coreq)])];
    }
  }

  return plan;
}
