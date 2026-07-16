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

// Términos conocidos por la DB local (GET /api/terms). Las fechas vienen de
// Mi Horario y pueden faltar si ese término nunca se sincronizó.
export const termInfoSchema = z.object({
  term: z.string(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
});
export type TermInfo = z.infer<typeof termInfoSchema>;

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

// Estado del scheduler + watcher (GET /api/state).
export const appStateSchema = z.object({
  schedule: z.object({ atISO: z.string() }).nullable(),
  watcher: z.object({ intervalMs: z.number() }).nullable(),
});
export type AppState = z.infer<typeof appStateSchema>;
