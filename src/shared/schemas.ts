import { z } from 'zod';
import { campusCodeSchema, campusSourceSchema } from './campus.ts';
import {
  ALWAYS_ON_CAPABILITY_IDS,
  GATED_CAPABILITY_IDS,
  PHASE_IDS,
  TERM_EVENT_IDS,
  TERM_EVENT_SOURCES,
} from './termPhase.ts';
// DAY_CODES es el vocabulario de días del portal. Se importa acá y no se
// redeclara para que las condiciones de horario no puedan aceptar un día que
// el resto del sistema no conoce. No hay ciclo: meetings.ts solo importa TIPOS
// de este archivo, y eso se borra al compilar.
import { DAY_CODES } from './meetings.ts';

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
  // Cuándo se observó este cupo. Un scraper no lo manda: lo observó recién y la
  // DB estampa la hora. Lo manda quien importa observaciones ya hechas (otra
  // base de mikampus), y ahí es imprescindible: sin esto un cupo de hace seis
  // semanas entraría marcado como de hoy y la UI diría que está fresco.
  capturedAt: z.string().nullable().default(null),
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
  // El campus no sale del HTML de resultados (el recon lo confirmó: la etiqueta
  // de campus solo aparece dentro del <select> del formulario). Lo pone el
  // orquestador según con qué filtro pidió la búsqueda, y por eso viaja junto a
  // su procedencia: un scraper que no filtró por campus entrega los dos en null
  // y la capa de escritura no borra lo que ya se sabía.
  campus: campusCodeSchema.nullable().default(null),
  campusSource: campusSourceSchema.nullable().default(null),
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
  // campus nunca viaja solo: sin su procedencia al lado, una inferencia por el
  // número de sección se leería como un dato que dijo el portal.
  campus: campusCodeSchema.nullable(),
  campusSource: campusSourceSchema.nullable(),
});
export type CatalogSection = z.infer<typeof catalogSectionSchema>;

// Las secciones de una materia partidas por campus, en el orden canónico (el
// campus del perfil primero). Lo resuelve el backend para que ninguna pantalla
// reimplemente la regla; al lado va la lista plana con el campo crudo, para que
// una pantalla que quiera otra presentación no tenga que deshacer esta.
export const catalogCampusGroupSchema = z.object({
  campus: campusCodeSchema.nullable(),
  label: z.string(),
  isHome: z.boolean(),
  sections: z.array(catalogSectionSchema),
});
export type CatalogCampusGroup = z.infer<typeof catalogCampusGroupSchema>;

export const catalogCourseSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  subject: z.string(),
  catalogNbr: z.string(),
  title: z.string(),
  career: z.string().nullable(),
  credits: z.number().nullable(),
  sections: z.array(catalogSectionSchema),
  campusGroups: z.array(catalogCampusGroupSchema),
});
export type CatalogCourse = z.infer<typeof catalogCourseSchema>;

export const catalogResponseSchema = z.object({
  term: z.string().nullable(),
  generatedAt: z.string(),
  // El campus del perfil con que se ordenó esta respuesta. Viaja acá para que
  // el cliente no tenga que pedir el perfil aparte para saber por qué el orden
  // es el que es.
  homeCampus: campusCodeSchema.nullable(),
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
  // La práctica que acompaña a la teórica. Va como su propia sección y no
  // anidada dentro de `section`: el grid la dibuja como cualquier otro bloque y
  // la hoja impresa la lista como una fila más, que es lo que la oficina teclea.
  relatedSection: catalogSectionSchema.nullable(),
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
// Ojo con los créditos: `positive()` era un bug, no una validación. Un
// laboratorio de física vale 0 unidades DE VERDAD (así lo emite el plan
// académico y así lo reporta el portal), y exigir > 0 hacía que la propuesta
// entera fallara la validación justo cuando el recomendador acertaba al
// incluirlo. Es `nonnegative()` en toda la cadena.
export const recommendedAlternativeSchema = z.object({
  courseId: z.number().int(),
  code: z.string(),
  title: z.string(),
  credits: z.number().nonnegative(),
  sections: z.number().int().positive(),
});

export const recommendedCourseSchema = z.object({
  courseId: z.number().int(),
  code: z.string(),
  title: z.string(),
  credits: z.number().nonnegative(),
  kind: z.enum(['obligatoria', 'electiva']),
  groupId: z.number().int(),
  groupLabel: z.string(),
  periodLabel: z.string(),
  reason: z.string(),
  section: catalogSectionSchema,
  alternatives: z.array(recommendedAlternativeSchema),
  // Cuántas materias del plan destraba aprobarla: es lo que separa una deuda
  // cara de una barata.
  unlocks: z.number().int().nonnegative().default(0),
  // No null por gusto: dice que esta fila entró porque es co-requisito de otra
  // (el laboratorio de su teoría), no porque se eligiera por sí misma.
  requiredBy: z.string().nullable().default(null),
  conditionalOn: z.array(z.string()).default([]),
});
export type RecommendedCourse = z.infer<typeof recommendedCourseSchema>;

// Lo que NO se puede proponer y por qué. Suele ser más útil que la propuesta:
// dice exactamente qué materia hay que aprobar para desatascar la carrera.
export const blockedCourseSchema = z.object({
  code: z.string(),
  title: z.string(),
  periodLabel: z.string(),
  reason: z.string(),
  missing: z.array(z.string()),
});
export type BlockedCourse = z.infer<typeof blockedCourseSchema>;

export const recommendationStrategySchema = z.enum(['ponerse-al-dia', 'avanzar']);
export type RecommendationStrategy = z.infer<typeof recommendationStrategySchema>;

export const recommendationResponseSchema = z.object({
  term: z.string(),
  generatedAt: z.string(),
  strategy: recommendationStrategySchema.default('ponerse-al-dia'),
  maxCredits: z.number().positive(),
  totalCredits: z.number().nonnegative(),
  recommendations: z.array(recommendedCourseSchema),
  blocked: z.array(blockedCourseSchema).default([]),
  schedule: z.object({
    valid: z.boolean(),
    adjusted: z.boolean(),
    omitted: z.array(z.object({ code: z.string(), reason: z.string() })),
  }),
  caveats: z.array(z.string()),
});
export type RecommendationResponse = z.infer<typeof recommendationResponseSchema>;

// Las dos propuestas del mismo ciclo. Cuál conviene no lo decide el algoritmo:
// depende de si pesa más no arrastrar deudas o no atrasar la graduación.
export const recommendationOptionsResponseSchema = z.object({
  term: z.string().nullable(),
  generatedAt: z.string(),
  plan: z
    .object({ code: z.string(), career: z.string().nullable(), issuedAt: z.string().nullable() })
    .nullable(),
  proposals: z.array(recommendationResponseSchema),
});
export type RecommendationOptionsResponse = z.infer<typeof recommendationOptionsResponseSchema>;

// ── Ruta a graduación (GET /api/degree-path) ────────────────────────────────
// Cuántos ciclos faltan colocando lo pendiente en el tiempo, y cuál de las dos
// restricciones —la cadena de prerrequisitos o el techo de créditos— fija esa
// fecha. Es cálculo local sobre el árbol de requisitos y el plan oficial; el
// contrato existe porque es el borde entre backend y frontend.
const degreePathCourseSchema = z.object({
  code: z.string(),
  title: z.string(),
  credits: z.number(),
  kind: z.enum(['obligatoria', 'electiva']),
  blockLabel: z.string(),
  unlocks: z.number().int(),
  chainLength: z.number().int(),
  critical: z.boolean(),
  requiredBy: z.string().nullable(),
  conditionalOn: z.array(z.string()).default([]),
});

export const degreePathResponseSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  maxCredits: z.number(),
  startTerm: z.string().nullable().default(null),
  generatedAt: z.string(),
  terms: z.array(
    z.object({
      index: z.number().int(),
      label: z.string().nullable(),
      credits: z.number(),
      courses: z.array(degreePathCourseSchema),
    })
  ),
  termsRemaining: z.number().int(),
  creditsRemaining: z.number(),
  coursesRemaining: z.number().int(),
  graduationTerm: z.string().nullable(),
  binding: z.enum(['prerrequisitos', 'carga', 'ambas', 'ninguna']),
  chainFloor: z.number().int(),
  loadFloor: z.number().int(),
  criticalPath: z.array(z.object({ code: z.string(), title: z.string() })),
  bottlenecks: z.array(
    z.object({
      code: z.string(),
      title: z.string(),
      unlocks: z.number().int(),
      chainLength: z.number().int(),
      termIndex: z.number().int(),
    })
  ),
  unscheduled: z.array(
    z.object({ code: z.string(), title: z.string(), reason: z.string(), missing: z.array(z.string()) })
  ),
  caveats: z.array(z.string()),
});
export type DegreePathResponse = z.infer<typeof degreePathResponseSchema>;

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

// ── Calendario del ciclo y fases ────────────────────────────────────────────
// Las etapas (inscripción, modificación, retiro, notas) con sus ventanas. El
// portal solo publica la primera; el resto lo carga el estudiante desde el
// calendario académico de PUCMM, que vive fuera del portal. Nada se siembra:
// un evento sin fila es un evento desconocido, y así se muestra.

export const termEventIdSchema = z.enum(TERM_EVENT_IDS);
export const termEventSourceSchema = z.enum(TERM_EVENT_SOURCES);

// Una fecha de calendario, sin hora. `precision` conserva el contrato del
// scraper de Enrollment Dates: 'date' significa literalmente que el portal no
// publicó hora, y es lo que impide que el scheduler dispare a una medianoche
// inventada.
const isoDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha va en formato AAAA-MM-DD');

// Media ventana conocida es válida; una fila sin ninguna fecha no dice nada y
// se representa con la ausencia de fila, no con una fila vacía. El orden se
// valida acá y no en SQLite porque un CHECK no puede explicar el error.
const hasSomeDate = <T extends { startsOn: string | null; endsOn: string | null }>(v: T) =>
  v.startsOn !== null || v.endsOn !== null;
const datesInOrder = <T extends { startsOn: string | null; endsOn: string | null }>(v: T) =>
  v.startsOn === null || v.endsOn === null || v.startsOn <= v.endsOn;

export const termEventSchema = z
  .object({
    event: termEventIdSchema,
    session: z.string().min(1).default('Regular Academic Session'),
    startsOn: isoDaySchema.nullable().default(null),
    endsOn: isoDaySchema.nullable().default(null),
    precision: z.enum(['date', 'datetime']).default('date'),
    source: termEventSourceSchema,
    sourceNote: z.string().nullable().default(null),
    updatedAt: z.string().nullable().default(null),
  })
  .refine(hasSomeDate, { message: 'Un evento del ciclo necesita al menos una de sus dos fechas' })
  .refine(datesInOrder, { message: 'La fecha de cierre no puede ser anterior a la de apertura' });
export type TermEventRow = z.infer<typeof termEventSchema>;

// Lo que el estudiante puede escribir. `source` no está: todo lo que entra por
// la API es suyo por definición, y dejarlo elegir 'portal' le permitiría
// disfrazar una fecha tipeada de dato del portal.
export const termEventInputSchema = z
  .object({
    event: termEventIdSchema,
    session: z.string().min(1).default('Regular Academic Session'),
    startsOn: isoDaySchema.nullable().default(null),
    endsOn: isoDaySchema.nullable().default(null),
    sourceNote: z.string().min(1).nullable().default(null),
  })
  .refine(hasSomeDate, { message: 'Un evento del ciclo necesita al menos una de sus dos fechas' })
  .refine(datesInOrder, { message: 'La fecha de cierre no puede ser anterior a la de apertura' });
export type TermEventInput = z.infer<typeof termEventInputSchema>;

export const termEventsResponseSchema = z.object({
  term: z.string().nullable(),
  termLabel: z.string().nullable(),
  events: z.array(termEventSchema),
});
export type TermEventsResponse = z.infer<typeof termEventsResponseSchema>;

// El estado de una capacidad viaja con su motivo: un control apagado sin
// explicación al lado es una pantalla que no se puede entender.
export const capabilityStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('habilitada') }),
  z.object({ state: z.literal('advertida'), reason: z.string() }),
  z.object({ state: z.literal('cerrada'), reason: z.string(), reopensOn: z.string().nullable() }),
]);

export const capabilityIdSchema = z.enum([...ALWAYS_ON_CAPABILITY_IDS, ...GATED_CAPABILITY_IDS]);

// La respuesta única desde la que el frontend gatea toda la app: fase, cuánto
// falta, qué falta por cargar y el mapa completo de capacidades. Que venga todo
// junto es el punto: si cada pantalla comparara fechas por su cuenta, en dos
// semanas habría tres reglas distintas.
export const termPhaseResponseSchema = z.object({
  term: z.string().nullable(),
  termLabel: z.string().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  phase: z.enum(PHASE_IDS),
  confidence: z.enum(['fechada', 'inferida', 'desconocida']),
  since: z.string().nullable(),
  until: z.string().nullable(),
  daysLeft: z.number().nullable(),
  open: z.array(termEventIdSchema),
  next: z
    .object({ event: termEventIdSchema, startsOn: z.string(), daysUntil: z.number() })
    .nullable(),
  missing: z.array(termEventIdSchema),
  capabilities: z.record(capabilityIdSchema, capabilityStateSchema),
  events: z.array(termEventSchema),
});
export type TermPhaseResponse = z.infer<typeof termPhaseResponseSchema>;

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

// La llave es `user_id`, no `id`: la tabla `profile` dejó de ser la fila única
// `id = 1` cuando pasó a tener un perfil por usuario (ver la migración en
// src/db.js). El esquema se quedó pidiendo el `id` viejo, así que el server
// devolvía una fila perfectamente válida y Zod la rechazaba en el browser:
// /academico y /trayectoria morían con "No se pudo leer lo guardado".
//
// `id` sigue aceptado como opcional para no romper una respuesta servida por
// una versión anterior del agente que todavía no migró.
export const profileSchema = z
  .object({
    user_id: z.number(),
    id: z.number().optional(),
    career: z.string().nullable(),
    pensum_no: z.string().nullable(),
    plan_label: z.string().nullable(),
    cohort_start_term: z.string().nullable(),
    // El campus del estudiante. Se elige, no se adivina: sin elegir queda null
    // y el catálogo no reordena nada.
    home_campus: campusCodeSchema.nullable().default(null),
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
// Los dos horizontes de P5, con su reconciliación. `currentTerm` y `graduation`
// vienen en null cuando el acumulado reconstruido no cuadra con el que publica
// PeopleSoft: la UI no esconde el número, es que no existe.
const horizonSchema = z.object({
  id: z.enum(['current-term', 'graduation']),
  label: z.string(),
  baseline: z.number().nullable(),
  baselineUnits: z.number(),
  futureCredits: z.number(),
  assumedAverage: z.number(),
  exact: z.number().nullable(),
  asPublished: z.number().nullable(),
});

const horizonScenariosSchema = z.object({
  best: horizonSchema,
  maintain: horizonSchema,
  floor: horizonSchema,
});

export const projectionReportSchema = z.object({
  reconciliation: z.object({
    status: z.enum(['match', 'mismatch', 'unknown']),
    official: z.number().nullable(),
    reconstructed: z.number().nullable(),
    difference: z.number().nullable(),
    precision: z.number(),
    explanation: z.string(),
  }),
  currentTerm: horizonScenariosSchema.nullable(),
  graduation: horizonScenariosSchema.nullable(),
  formula: z.string(),
});
export type ProjectionReport = z.infer<typeof projectionReportSchema>;

export const goalsResponseSchema = z.object({
  goals: z.array(goalEvaluationSchema),
  projection: gpaProjectionSchema.nullable(),
  horizons: projectionReportSchema,
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

// Los metadatos que ordenan las señales (P5 §7) viajan con cada una: la UI
// pinta por severidad y agrupa por prioridad sin recalcular nada.
const insightMetaShape = {
  severity: z.enum(['risk', 'watch', 'info']),
  recency: z.enum(['current', 'recent', 'historical']),
  actionability: z.enum(['act', 'consider', 'context']),
  confidence: z.enum(['high', 'medium', 'low']),
};

const termPointSchema = z.object({ term: z.string(), gpa: z.number() });

export const insightSchema = z.discriminatedUnion('kind', [
  // El cambio reciente y la tendencia son señales distintas a propósito: se
  // puede venir subiendo tres ciclos y haber caído el último.
  z.object({
    kind: z.literal('recent-change'),
    direction: z.enum(['up', 'down', 'flat']),
    delta: z.number(),
    from: termPointSchema,
    to: termPointSchema,
    ...insightMetaShape,
  }),
  z.object({
    kind: z.literal('rolling-trend'),
    direction: z.enum(['rising', 'falling', 'flat']),
    delta: z.number(),
    points: z.array(termPointSchema),
    ...insightMetaShape,
  }),
  z.object({ kind: z.literal('area-performance'), best: areaStatSchema, worst: areaStatSchema, ...insightMetaShape }),
  z.object({ kind: z.literal('load-vs-result'), heavy: loadStatSchema, light: loadStatSchema, ...insightMetaShape }),
  z.object({
    kind: z.literal('repeated-courses'),
    courses: z.array(
      z.object({
        code: z.string(),
        attempts: z.array(z.object({ term: z.string().nullable(), grade: z.string().nullable() })),
      })
    ),
    ...insightMetaShape,
  }),
  z.object({
    kind: z.literal('withdrawn-courses'),
    count: z.number().int(),
    codes: z.array(z.string()),
    ...insightMetaShape,
  }),
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
  schedule: z.object({ atISO: z.string(), prewarmAtISO: z.string(), prewarmed: z.boolean() }).nullable(),
  // El ritmo configurado existe con el watcher apagado: se puede elegir cada
  // cuánto vigilar ANTES de encenderlo. `tickMs` es lo que se configura;
  // `effectiveIntervalMs` es lo que de verdad le toca a cada materia cuando hay
  // varias rotando en el mismo loop.
  watcherSettings: z
    .object({
      tickMs: z.number(),
      minTickMs: z.number(),
      maxTickMs: z.number(),
      watchedCourses: z.number().int(),
      effectiveIntervalMs: z.number(),
    })
    .default({ tickMs: 45_000, minTickMs: 30_000, maxTickMs: 3_600_000, watchedCourses: 0, effectiveIntervalMs: 45_000 }),
  // intervalMs es el ciclo efectivo de la materia en el loop compartido;
  // lastCheckAt null = activo pero todavía sin consultar su materia.
  watcher: z
    .object({
      intervalMs: z.number(),
      tickMs: z.number().default(45_000),
      lastCheckAt: z.string().nullable().default(null),
      autoEnroll: z.boolean().default(false),
      // Qué hechos del portal interrumpen a esta persona. El default 'both' es
      // el comportamiento histórico, así que un estado servido por una versión
      // anterior se lee sin romperse.
      scope: z.enum(['seats', 'groups', 'both']).default('both'),
      activationOrder: z.number().int().nullable().default(null),
      appointmentAt: z.string().nullable().default(null),
      status: z.enum(['running', 'paused', 'offline', 'credentials-required', 'backing-off', 'stopped', 'monitoring-gap']).default('running'),
      nextCheckAt: z.string().nullable().default(null),
      consecutiveFailures: z.number().int().default(0),
      pauseReason: z.string().nullable().default(null),
      lastState: z.string().nullable().default(null),
      queue: z.array(z.object({ courseCode: z.string(), position: z.number().int(), total: z.number().int() })).default([]),
    })
    .nullable(),
});
export type AppState = z.infer<typeof appStateSchema>;

// La cuenta vigente, para la pantalla de Ajustes. La contraseña nunca sale del
// backend: acá solo el usuario y el origen histórico del registro; el runtime
// local ya no lee account.json ni credenciales desde .env.
export const accountInfoSchema = z.object({
  username: z.string().nullable().default(null),
  source: z.enum(['account.json', '.env']),
  configured: z.boolean(),
});
export type AccountInfo = z.infer<typeof accountInfoSchema>;

// ── Mesa de inscripción ─────────────────────────────────────────────────────

// Una sección con el veredicto de frescura ya resuelto. El backend decide si
// una observación de cupo todavía vale como estado, en vez de mandar la fecha y
// que cada pantalla saque su propia conclusión (y saque una distinta).
export const mesaSectionSchema = catalogSectionSchema.extend({
  seatsAgeHours: z.number().nullable(),
  seatsFresh: z.boolean(),
});
export type MesaSection = z.infer<typeof mesaSectionSchema>;

export const mesaCampusGroupSchema = catalogCampusGroupSchema.extend({
  sections: z.array(mesaSectionSchema),
});

// Una materia que te falta y que este ciclo se oferta. `credits` ya viene
// resuelto desde el pénsum: el catálogo los tiene en NULL casi siempre.
export const mesaCandidateSchema = catalogCourseSchema.extend({
  courseId: z.number().int(),
  credits: z.number(),
  kind: z.enum(['obligatoria', 'electiva']),
  groupId: z.number().int(),
  groupLabel: z.string(),
  periodLabel: z.string(),
  position: z.number().int(),
  sections: z.array(mesaSectionSchema),
  campusGroups: z.array(mesaCampusGroupSchema),
});
export type MesaCandidate = z.infer<typeof mesaCandidateSchema>;

export const mesaEnrolledSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  subject: z.string(),
  catalogNbr: z.string(),
  title: z.string(),
  status: z.string(),
  units: z.number().nullable(),
  sections: z.array(
    z.object({
      id: z.number().int(),
      classNbr: z.string(),
      section: z.string().nullable(),
      component: z.string().nullable(),
      instructor: z.string().nullable(),
      meetings: z.array(meetingSchema),
      startDate: z.string().nullable(),
      endDate: z.string().nullable(),
    })
  ),
});
export type MesaEnrolled = z.infer<typeof mesaEnrolledSchema>;

export const mesaResponseSchema = z.object({
  term: z.string(),
  generatedAt: z.string(),
  homeCampus: campusCodeSchema.nullable(),
  phase: termPhaseResponseSchema,
  enrolled: z.array(mesaEnrolledSchema),
  candidates: z.array(mesaCandidateSchema),
  plan: planDetailSchema.nullable(),
  seats: z.object({
    capturedAt: z.string().nullable(),
    ageHours: z.number().nullable(),
    fresh: z.boolean(),
    freshHours: z.number(),
  }),
  totals: z.object({
    enrolledCredits: z.number(),
    selectedCredits: z.number(),
    credits: z.number(),
    enrolledCourses: z.number().int(),
    selectedCourses: z.number().int(),
  }),
});
export type MesaResponse = z.infer<typeof mesaResponseSchema>;

// Las condiciones duras que el estudiante le pone a su horario. Todo en null o
// vacío es "sin condición": quien no pide nada obtiene el comportamiento de
// siempre. Un string de hora es "HH:MM".
export const scheduleConstraintsSchema = z.object({
  earliestStart: z.string().nullable().default(null),
  latestEnd: z.string().nullable().default(null),
  freeDays: z.array(z.enum(DAY_CODES)).default([]),
  maxDays: z.number().int().positive().nullable().default(null),
  campuses: z.array(campusCodeSchema).nullable().default(null),
});
export type ScheduleConstraintsInput = z.infer<typeof scheduleConstraintsSchema>;

export const mesaSolveResponseSchema = z.object({
  term: z.string(),
  constraints: scheduleConstraintsSchema,
  truncated: z.boolean(),
  // Materias que se quedaron sin ninguna sección posible por culpa de las
  // condiciones. Es el dato que convierte un "no hay combinación" en algo
  // accionable: dice cuál aflojar.
  blocked: z.array(
    z.object({ code: z.string(), title: z.string(), reasons: z.array(z.string()) })
  ),
  dropped: z.array(z.object({ code: z.string(), classNbr: z.string(), reason: z.string() })),
  combinations: z.array(
    z.object({
      penalty: z.number(),
      metrics: z.object({
        gapMinutes: z.number(),
        earlyMinutes: z.number(),
        daysUsed: z.number().int(),
      }),
      sections: z.array(
        z.object({
          id: z.number().int(),
          courseId: z.number().int(),
          code: z.string(),
          title: z.string(),
          classNbr: z.string(),
          section: z.string().nullable(),
          component: z.string().nullable(),
          instructor: z.string().nullable(),
          meetings: z.array(meetingSchema),
          campus: campusCodeSchema.nullable(),
        })
      ),
    })
  ),
});
export type MesaSolveResponse = z.infer<typeof mesaSolveResponseSchema>;
