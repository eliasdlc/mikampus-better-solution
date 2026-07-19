import { z } from 'zod';

// Contratos compartidos backend/frontend. El scraping es frágil: PeopleSoft
// cambia IDs entre parches y devuelve HTML inconsistente. Validar el output de
// cada scraper contra estos esquemas en el borde (antes de tocar la DB o la UI)
// convierte un selector roto en un error claro y ubicable, no en datos basura
// propagándose por toda la app.

// El portal muestra el estado del cupo como texto/alt de imagen ("Open",
// "Wait List", "Closed"). Lo normalizamos a un enum estable que la UI tiñe.
export const seatStatusSchema = z.enum(['open', 'waitlist', 'closed']);
export type SeatStatus = z.infer<typeof seatStatusSchema>;

// Traduce el alt de PeopleSoft al enum. Cualquier cosa no reconocida cae a
// 'closed' (lo más conservador: nunca decir "hay cupo" si no estamos seguros).
export function normalizeSeatStatus(raw: string | null | undefined): SeatStatus {
  const t = (raw ?? '').trim().toLowerCase();
  if (t.includes('open') || t.includes('abiert')) return 'open';
  if (t.includes('wait') || t.includes('espera')) return 'waitlist';
  return 'closed';
}

// Un patrón de reunión de una sección. Los horarios en formato "HH:MM" 24h,
// días con el código de dos letras de PeopleSoft ("Mo", "Tu"...) — se traducen
// a español en la UI, no acá (ver shared/meetings.ts). room puede faltar: el
// portal escribe "TBA" cuando el aula no está asignada, y eso se guarda null.
export const meetingSchema = z.object({
  days: z.array(z.string()).default([]),
  start: z.string().nullable().default(null),
  end: z.string().nullable().default(null),
  room: z.string().nullable().default(null),
});
export type Meeting = z.infer<typeof meetingSchema>;

export const seatInfoSchema = z.object({
  status: seatStatusSchema,
  open: z.number().int().nullable().default(null),
  capacity: z.number().int().nullable().default(null),
  waitTotal: z.number().int().nullable().default(null),
});
export type SeatInfo = z.infer<typeof seatInfoSchema>;

// Lo que un scraper de catálogo debe entregar por cada sección antes de que
// toque la DB. Si algún campo obligatorio no aparece, Zod grita acá.
export const scrapedSectionSchema = z.object({
  courseCode: z.string().min(1),
  subject: z.string().min(1),
  catalogNbr: z.string().min(1),
  // Nullable a propósito: el class search no expone el título de la materia,
  // así que el scraper de catálogo entrega null y la capa de DB conserva el
  // que ya conozca (ver resolveTitle en peoplesoft/catalog.js).
  title: z.string().min(1).nullable().default(null),
  career: z.string().nullable().default(null),
  credits: z.number().nullable().default(null),
  term: z.string().min(1),
  classNbr: z.string().min(1),
  section: z.string().nullable().default(null),
  component: z.string().nullable().default(null),
  instructor: z.string().nullable().default(null),
  meetings: z.array(meetingSchema).default([]),
  seats: seatInfoSchema.nullable().default(null),
});
export type ScrapedSection = z.infer<typeof scrapedSectionSchema>;

// Forma con la que el catálogo viaja al frontend (GET /api/catalog): una
// materia con sus secciones anidadas. El índice MiniSearch se construye sobre
// esto en el cliente.
export const catalogSectionSchema = z.object({
  id: z.number().int(),
  // El término viaja por sección (no solo como filtro de la respuesta): las
  // acciones en vivo (agregar al carrito) lo necesitan, y un catálogo pedido
  // sin filtro no tiene término global.
  term: z.string(),
  classNbr: z.string(),
  section: z.string().nullable(),
  component: z.string().nullable(),
  instructor: z.string().nullable(),
  meetings: z.array(meetingSchema),
  seats: seatInfoSchema.nullable(),
  seatsUpdatedAt: z.string().nullable(),
});
export type CatalogSection = z.infer<typeof catalogSectionSchema>;

export const catalogCourseSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  subject: z.string(),
  catalogNbr: z.string(),
  title: z.string(),
  career: z.string().nullable(),
  credits: z.number().nullable(),
  sections: z.array(catalogSectionSchema),
});
export type CatalogCourse = z.infer<typeof catalogCourseSchema>;

export const catalogResponseSchema = z.object({
  term: z.string().nullable(),
  generatedAt: z.string(),
  courses: z.array(catalogCourseSchema),
});
export type CatalogResponse = z.infer<typeof catalogResponseSchema>;

// ── Mi Horario ─────────────────────────────────────────────────────────────
// El horario inscrito es, además del horario, la mejor fuente de títulos y
// créditos que tenemos: el class search no los expone y acá sí vienen.

export const enrollStatusSchema = z.enum(['enrolled', 'dropped', 'waitlisted']);
export type EnrollStatus = z.infer<typeof enrollStatusSchema>;

// El portal escribe "Enrolled" / "Dropped" / "Waitlisted". Lo desconocido cae
// a 'enrolled' porque la pantalla solo lista lo que está en tu horario.
export function normalizeEnrollStatus(raw: string | null | undefined): EnrollStatus {
  const t = (raw ?? '').trim().toLowerCase();
  if (t.includes('drop') || t.includes('baja')) return 'dropped';
  if (t.includes('wait') || t.includes('espera')) return 'waitlisted';
  return 'enrolled';
}

// Una sección inscrita, tal como sale del scraper de Mi Horario.
export const scrapedEnrolledSectionSchema = z.object({
  classNbr: z.string().min(1),
  section: z.string().nullable().default(null),
  component: z.string().nullable().default(null),
  instructor: z.string().nullable().default(null),
  meetings: z.array(meetingSchema).default([]),
  startDate: z.string().nullable().default(null),
  endDate: z.string().nullable().default(null),
});

// Una materia inscrita con sus componentes (una LEC y su PRA van juntas).
export const scrapedEnrollmentSchema = z.object({
  courseCode: z.string().min(1),
  subject: z.string().min(1),
  catalogNbr: z.string().min(1),
  title: z.string().min(1).nullable().default(null),
  status: enrollStatusSchema,
  units: z.number().nullable().default(null),
  grading: z.string().nullable().default(null),
  grade: z.string().nullable().default(null),
  sections: z.array(scrapedEnrolledSectionSchema).min(1),
});
export type ScrapedEnrollment = z.infer<typeof scrapedEnrollmentSchema>;

export const scrapedScheduleSchema = z.object({
  term: z.string().min(1),
  // La etiqueta en español del término ("Septiembre de 2026"), de la cabecera de
  // Mi Horario. Es lo que cruza el STRM con el vocabulario de grades. Nullable:
  // si el portal cambia el layout de la cabecera, el horario igual se guarda.
  termLabel: z.string().nullable().default(null),
  courses: z.array(scrapedEnrollmentSchema),
});
export type ScrapedSchedule = z.infer<typeof scrapedScheduleSchema>;

// Forma con la que el horario viaja al frontend (GET /api/schedule).
export const scheduleSectionSchema = scrapedEnrolledSectionSchema.extend({
  id: z.number().int(),
});

export const scheduleCourseSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  subject: z.string(),
  catalogNbr: z.string(),
  title: z.string(),
  status: enrollStatusSchema,
  units: z.number().nullable(),
  grading: z.string().nullable(),
  grade: z.string().nullable(),
  sections: z.array(scheduleSectionSchema),
});
export type ScheduleCourse = z.infer<typeof scheduleCourseSchema>;

export const scheduleResponseSchema = z.object({
  term: z.string().nullable(),
  generatedAt: z.string(),
  syncedAt: z.string().nullable(),
  courses: z.array(scheduleCourseSchema),
});
export type ScheduleResponse = z.infer<typeof scheduleResponseSchema>;

// Términos conocidos por la DB local (GET /api/terms), ya resueltos contra hoy.
// `term` es el identificador que usa el resto de la app: el STRM si lo hay, si
// no la etiqueta. `code` es el STRM (null si el término solo vive en grades) y
// `label` la etiqueta en español. Las fechas vienen de Mi Horario y pueden
// faltar. hasSchedule = tiene horario inscrito; hasSections = es plannable.
export const termInfoSchema = z.object({
  term: z.string(),
  code: z.string().nullable(),
  label: z.string().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  sortKey: z.string().nullable(),
  isCurrent: z.boolean(),
  isNext: z.boolean(),
  hasSchedule: z.boolean(),
  hasSections: z.boolean(),
});
export type TermInfo = z.infer<typeof termInfoSchema>;

// El contexto de tiempo que devuelve /api/terms además de la lista: cuál ciclo
// corre hoy y cuál es el siguiente (o null si no se puede resolver). Es lo que
// el Dashboard y /horario leen para no mezclar ciclos.
export const termContextSchema = z.object({
  terms: z.array(termInfoSchema),
  current: termInfoSchema.nullable(),
  next: termInfoSchema.nullable(),
});
export type TermContext = z.infer<typeof termContextSchema>;

// ── Planes de ciclo ──────────────────────────────────────────────────────────
// Un plan junta materias de un término. 'desired' = sin grupo elegido (chip
// punteado, sin bloque en el grid); 'planned' = con sección concreta. El
// estado lo dicta la presencia de sección — lo garantiza src/plans.js.

export const planItemStatusSchema = z.enum(['desired', 'planned']);

export const planItemSchema = z.object({
  id: z.number().int(),
  courseId: z.number().int(),
  code: z.string(),
  title: z.string(),
  credits: z.number().nullable(),
  // subject, career y catalogNbr viajan porque "enviar al carrito" los
  // necesita para reconstruir la búsqueda en el portal.
  subject: z.string(),
  career: z.string().nullable(),
  catalogNbr: z.string(),
  status: planItemStatusSchema,
  note: z.string().nullable(),
  locked: z.boolean(),
  section: catalogSectionSchema.nullable(),
});
export type PlanItem = z.infer<typeof planItemSchema>;

export const planSummarySchema = z.object({
  id: z.number().int(),
  term: z.string(),
  name: z.string(),
  itemCount: z.number().int(),
  credits: z.number(),
  updatedAt: z.string(),
});
export type PlanSummary = z.infer<typeof planSummarySchema>;

export const planDetailSchema = z.object({
  id: z.number().int(),
  term: z.string(),
  name: z.string(),
  updatedAt: z.string(),
  items: z.array(planItemSchema),
});
export type PlanDetail = z.infer<typeof planDetailSchema>;

// Resultado de mandar un plan al carrito, materia por materia (agregada ✓ /
// ya estaba / falló ✗ y por qué).
export const planToCartResultSchema = z.object({
  results: z.array(
    z.object({
      itemId: z.number().int(),
      code: z.string(),
      title: z.string(),
      ok: z.boolean(),
      alreadyInCart: z.boolean().default(false),
      error: z.string().nullable().default(null),
    })
  ),
});
export type PlanToCartResult = z.infer<typeof planToCartResultSchema>;

// ── Recomendador de ciclo ──────────────────────────────────────────────────
// La propuesta explica cada materia y ya trae la sección elegida por el solver.
// Crear el plan persiste exactamente esta combinación después de recalcularla
// en el server; el frontend nunca puede colar una sección arbitraria.
export const recommendedAlternativeSchema = z.object({
  courseId: z.number().int(),
  code: z.string(),
  title: z.string(),
  credits: z.number().positive(),
  sections: z.number().int().positive(),
});

export const recommendedCourseSchema = z.object({
  courseId: z.number().int(),
  code: z.string(),
  title: z.string(),
  credits: z.number().positive(),
  kind: z.enum(['obligatoria', 'electiva']),
  groupId: z.number().int(),
  groupLabel: z.string(),
  periodLabel: z.string(),
  reason: z.string(),
  section: catalogSectionSchema,
  alternatives: z.array(recommendedAlternativeSchema),
});
export type RecommendedCourse = z.infer<typeof recommendedCourseSchema>;

export const recommendationResponseSchema = z.object({
  term: z.string(),
  generatedAt: z.string(),
  maxCredits: z.number().positive(),
  totalCredits: z.number().nonnegative(),
  recommendations: z.array(recommendedCourseSchema),
  schedule: z.object({
    valid: z.boolean(),
    adjusted: z.boolean(),
    omitted: z.array(z.object({ code: z.string(), reason: z.string() })),
  }),
  caveats: z.array(z.string()),
});
export type RecommendationResponse = z.infer<typeof recommendationResponseSchema>;

// Carrito real (GET /api/cart), enriquecido: además del label crudo del portal,
// el código canónico (color estable + cruce con el catálogo), el título del
// diccionario local, el horario parseado (para proyectar el carrito en el
// WeeklyGrid de /inscripcion) y el estado del cupo ya normalizado.
export const cartRowSchema = z.object({
  index: z.number().int(),
  classLabel: z.string(),
  // null cuando el label del portal no se pudo partir en código canónico: la
  // fila se muestra igual con su texto crudo, solo pierde color y título.
  courseCode: z.string().nullable(),
  title: z.string(),
  section: z.string().nullable(),
  // El label del carrito trae el class number entre paréntesis: es la llave
  // exacta contra `sections` (term + class_nbr) para cruzar con el catálogo.
  classNbr: z.string().nullable(),
  instructor: z.string().nullable(),
  credits: z.number().nullable(),
  campus: z.string().nullable(),
  meetings: z.array(meetingSchema),
  status: seatStatusSchema.nullable(),
});
export type CartRow = z.infer<typeof cartRowSchema>;

// El carrito viaja con su syncedAt como el horario y las notas: la pantalla
// muestra lo cacheado con su StalenessTag y decide si refrescar. Entrar a una
// pantalla nunca dispara scraping.
export const cartResponseSchema = z.object({
  generatedAt: z.string(),
  syncedAt: z.string().nullable(),
  rows: z.array(cartRowSchema),
});
export type CartResponse = z.infer<typeof cartResponseSchema>;

// El recon de jul-2026 confirmó que esta instalación de PeopleSoft no expone
// el Validate nativo ni un control de waitlist en los pasos 1/2 del carrito.
// El endpoint conserva un contrato explícito para que la UI pueda decirlo y
// para detectar si un parche futuro habilita alguno de los dos controles.
export const cartCapabilitySchema = z.object({
  supported: z.boolean(),
  reason: z.string().nullable().default(null),
});

export const cartValidationResponseSchema = z.object({
  validatedAt: z.string(),
  validate: cartCapabilitySchema,
  waitlistChoice: cartCapabilitySchema,
  waitlistPosition: cartCapabilitySchema,
  results: z.array(
    z.object({
      classLabel: z.string(),
      success: z.boolean(),
      message: z.string(),
    })
  ),
});
export type CartValidationResponse = z.infer<typeof cartValidationResponseSchema>;

// Enrollment Dates. precision='date' significa literalmente que el portal no
// publicó hora: nunca se convierte a medianoche ni alimenta el scheduler.
export const enrollmentWindowSchema = z.object({
  termCode: z.string(),
  session: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  precision: z.enum(['date', 'datetime']),
  userId: z.number().int(),
  syncedAt: z.string(),
});
export type EnrollmentWindow = z.infer<typeof enrollmentWindowSchema>;

export const enrollmentWindowsResponseSchema = z.object({
  syncedAt: z.string().nullable(),
  windows: z.array(enrollmentWindowSchema),
});
export type EnrollmentWindowsResponse = z.infer<typeof enrollmentWindowsResponseSchema>;

export const dropResultSchema = z.object({
  ok: z.boolean(),
  courseCode: z.string(),
  classLabel: z.string(),
  message: z.string(),
});
export type DropResult = z.infer<typeof dropResultSchema>;

// ── Notas y avance ──────────────────────────────────────────────────────────

// Course History marca cada materia con el alt de un icono: Taken / In
// Progress / Transferred. 'transferred' son las convalidadas (nota "EXO", 0
// créditos) y no entran al índice — ver shared/gpa.ts.
export const courseHistoryStatusSchema = z.enum(['taken', 'in_progress', 'transferred']);
export type CourseHistoryStatus = z.infer<typeof courseHistoryStatusSchema>;

// Una materia del histórico. `grade` es null mientras se cursa; `term` es la
// etiqueta en español del portal ("Enero de 2026"), que shared/gpa.ts sabe
// ordenar.
export const gradedCourseSchema = z.object({
  code: z.string().min(1),
  subject: z.string().min(1),
  catalogNbr: z.string().min(1),
  title: z.string().min(1).nullable().default(null),
  term: z.string().min(1).nullable().default(null),
  grade: z.string().min(1).nullable().default(null),
  units: z.number().nullable().default(null),
  status: courseHistoryStatusSchema,
});
export type GradedCourse = z.infer<typeof gradedCourseSchema>;

export const scrapedCourseHistorySchema = z.object({
  courses: z.array(gradedCourseSchema),
});

// Los totales del índice. Se calculan (no se scrapean) y reproducen exacto los
// que publica el portal.
export const gpaSummarySchema = z.object({
  unitsTowardGpa: z.number(),
  gradePoints: z.number(),
  unitsPassed: z.number(),
  unitsInProgress: z.number(),
  gpa: z.number().nullable(),
});

export const termGradesSchema = gpaSummarySchema.extend({
  term: z.string(),
  sortKey: z.string().nullable(),
  courses: z.array(gradedCourseSchema),
});
export type TermGrades = z.infer<typeof termGradesSchema>;

export const gradesResponseSchema = z.object({
  generatedAt: z.string(),
  syncedAt: z.string().nullable(),
  terms: z.array(termGradesSchema),
  summary: gpaSummarySchema,
});
export type GradesResponse = z.infer<typeof gradesResponseSchema>;

// ── Pénsum y avance ─────────────────────────────────────────────────────────

// Estados que el advisement report sí publica. NO hay 'eligible': el informe no
// menciona prerequisitos en ninguna parte, así que la elegibilidad no se puede
// calcular (riesgo previsto en el §8 del plan, confirmado en el recon de Fase 4).
export const pensumStatusSchema = z.enum(['taken', 'in_progress', 'planned', 'pending']);

export const pensumCourseSchema = z.object({
  code: z.string(),
  subject: z.string(),
  catalogNbr: z.string(),
  title: z.string().nullable(),
  units: z.number().nullable(),
  status: pensumStatusSchema,
  takenTerm: z.string().nullable(),
  grade: z.string().nullable(),
  // null cuando el catálogo local todavía no conoce la materia: sin id no hay
  // con qué agregarla a un plan.
  courseId: z.number().int().nullable(),
  // Pendiente Y con secciones este término. Es lo más cerca de "elegible" que
  // se puede afirmar sin prerequisitos: dice que se está ofertando, no que
  // cumplas los requisitos para tomarla.
  offered: z.boolean(),
});
export type PensumCourse = z.infer<typeof pensumCourseSchema>;

export const pensumResponseSchema = z.object({
  term: z.string().nullable(),
  generatedAt: z.string(),
  syncedAt: z.string().nullable(),
  courses: z.array(pensumCourseSchema),
});
export type PensumResponse = z.infer<typeof pensumResponseSchema>;

// ── El árbol de requisitos (parser v2): período → obligatorios/electivas ──
export const requirementKindSchema = z.enum(['root', 'periodo', 'obligatorios', 'electiva', 'grupo']);

// Un curso dentro de un grupo. Es un pensumCourse + si es candidata de electiva
// (una opción, no una obligatoria).
export const requirementItemSchema = pensumCourseSchema.extend({
  isCandidate: z.boolean(),
});
export type RequirementItem = z.infer<typeof requirementItemSchema>;

const requirementCountsSchema = z.object({
  required: z.number().nullable(),
  taken: z.number().nullable(),
  needed: z.number().nullable(),
});

// Recursivo: un grupo tiene hijos que son grupos. z.lazy + tipo explícito
// porque Zod no infiere estructuras que se referencian a sí mismas.
export type RequirementGroup = {
  id: number;
  kind: z.infer<typeof requirementKindSchema>;
  label: string;
  year: number | null;
  period: number | null;
  satisfied: boolean;
  collapsed: boolean;
  position: number;
  units: z.infer<typeof requirementCountsSchema>;
  courses: z.infer<typeof requirementCountsSchema>;
  gpaActual: number | null;
  items: RequirementItem[];
  children: RequirementGroup[];
};
export const requirementGroupSchema: z.ZodType<RequirementGroup> = z.lazy(() =>
  z.object({
    id: z.number(),
    kind: requirementKindSchema,
    label: z.string(),
    year: z.number().nullable(),
    period: z.number().nullable(),
    satisfied: z.boolean(),
    collapsed: z.boolean(),
    position: z.number(),
    units: requirementCountsSchema,
    courses: requirementCountsSchema,
    gpaActual: z.number().nullable(),
    items: z.array(requirementItemSchema),
    children: z.array(requirementGroupSchema),
  })
);

export const profileSchema = z
  .object({
    id: z.number(),
    career: z.string().nullable(),
    pensum_no: z.string().nullable(),
    plan_label: z.string().nullable(),
    cohort_start_term: z.string().nullable(),
    updated_at: z.string(),
  })
  .nullable();
export type Profile = z.infer<typeof profileSchema>;

export const requirementsResponseSchema = z.object({
  term: z.string().nullable(),
  syncedAt: z.string().nullable(),
  profile: profileSchema,
  tree: requirementGroupSchema.nullable(),
});
export type RequirementsResponse = z.infer<typeof requirementsResponseSchema>;

export const profileResponseSchema = z.object({
  profile: profileSchema,
  syncedAt: z.string().nullable(),
});
export type ProfileResponse = z.infer<typeof profileResponseSchema>;

// ── Metas y señales (Fase 10, §12.7) ─────────────────────────────────────────
// Todo esto se calcula local (nunca se scrapea) con la aritmética de gpa.ts. El
// contrato existe igual: es el borde entre backend y frontend, y valida que el
// motor devuelve lo que la UI espera.

// El abanico honesto de índice final sobre los créditos que faltan del pénsum.
export const gpaProjectionSchema = z.object({
  remainingCredits: z.number(),
  current: z.number().nullable(),
  best: z.number().nullable(), // todo A
  maintain: z.number().nullable(), // mantenés tu promedio
  floor: z.number().nullable(), // todo C
});
export type GpaProjectionResponse = z.infer<typeof gpaProjectionSchema>;

export const goalVerdictSchema = z.enum(['met', 'secured', 'reachable', 'tight', 'unreachable']);

export const goalSchema = z.object({
  id: z.number().int(),
  kind: z.literal('gpa'),
  target: z.number(),
  deadlineTerm: z.string().nullable(),
  createdAt: z.string(),
  achievedAt: z.string().nullable(),
});
export type Goal = z.infer<typeof goalSchema>;

// La meta con su veredicto calculado en vivo contra las notas del momento.
export const goalEvaluationSchema = goalSchema.extend({
  verdict: goalVerdictSchema,
  // Promedio (0–4) que exige lo que falta. null cuando no quedan créditos.
  requiredAverage: z.number().nullable(),
  projectedIfMaintain: z.number().nullable(),
});
export type GoalEvaluation = z.infer<typeof goalEvaluationSchema>;

// Metas + proyección viajan juntas: la UI las muestra en el mismo panel y una
// mutación de meta refresca ambas. basedOn dice sobre cuántos créditos al índice
// se calcula todo, para que el número no salga sin su base.
export const goalsResponseSchema = z.object({
  goals: z.array(goalEvaluationSchema),
  projection: gpaProjectionSchema.nullable(),
  basedOn: z.object({
    gpa: z.number().nullable(),
    unitsTowardGpa: z.number(),
    remainingCredits: z.number(),
  }),
  syncedAt: z.string().nullable(),
});
export type GoalsResponse = z.infer<typeof goalsResponseSchema>;

// Señales descriptivas. Discriminadas por kind: la UI mapea cada una a su forma
// sin adivinar. Una señal ausente del arreglo es una señal bajo su umbral.
const areaStatSchema = z.object({ subject: z.string(), gpa: z.number(), count: z.number().int() });
const loadStatSchema = z.object({ avgGpa: z.number(), avgCredits: z.number(), terms: z.number().int() });

export const insightSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('gpa-trend'),
    direction: z.enum(['rising', 'falling', 'flat']),
    delta: z.number(),
    points: z.array(z.object({ term: z.string(), gpa: z.number() })),
  }),
  z.object({ kind: z.literal('area-performance'), best: areaStatSchema, worst: areaStatSchema }),
  z.object({ kind: z.literal('load-vs-result'), heavy: loadStatSchema, light: loadStatSchema }),
  z.object({
    kind: z.literal('repeated-courses'),
    courses: z.array(
      z.object({
        code: z.string(),
        attempts: z.array(z.object({ term: z.string().nullable(), grade: z.string().nullable() })),
      })
    ),
  }),
  z.object({ kind: z.literal('withdrawn-courses'), count: z.number().int(), codes: z.array(z.string()) }),
]);
export type Insight = z.infer<typeof insightSchema>;

export const insightsResponseSchema = z.object({
  insights: z.array(insightSchema),
  syncedAt: z.string().nullable(),
});
export type InsightsResponse = z.infer<typeof insightsResponseSchema>;

// 'unknown' no es "no bloquea": es "el portal no nos lo dijo". Ver
// peoplesoft/holds.js — sin un hold real que mirar, la severidad no se inventa.
export const holdSeveritySchema = z.enum(['blocking', 'info', 'unknown']);

export const holdSchema = z.object({
  code: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  severity: holdSeveritySchema,
  link: z.string().nullable(),
});
export type Hold = z.infer<typeof holdSchema>;

export const holdsResponseSchema = z.object({
  generatedAt: z.string(),
  syncedAt: z.string().nullable(),
  holds: z.array(holdSchema),
});
export type HoldsResponse = z.infer<typeof holdsResponseSchema>;

// Estado del scheduler + watcher (GET /api/state).
export const appStateSchema = z.object({
  schedule: z.object({ atISO: z.string() }).nullable(),
  // intervalMs es el ciclo efectivo de la materia en el loop compartido;
  // lastCheckAt null = activo pero todavía sin consultar su materia.
  watcher: z
    .object({ intervalMs: z.number(), lastCheckAt: z.string().nullable().default(null) })
    .nullable(),
});
export type AppState = z.infer<typeof appStateSchema>;

// La cuenta vigente, para la pantalla de Ajustes. La contraseña nunca sale del
// backend: acá solo el usuario y de dónde salió (account.json o el .env).
export const accountInfoSchema = z.object({
  username: z.string().nullable().default(null),
  source: z.enum(['account.json', '.env']),
  configured: z.boolean(),
});
export type AccountInfo = z.infer<typeof accountInfoSchema>;
