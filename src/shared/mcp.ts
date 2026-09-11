import { z } from 'zod';

// Contratos del servidor MCP local. Viven acá y no en src/mcp/ porque tsconfig
// solo typechequea web/src y src/shared: un contrato que el compilador no mira
// deja de ser un contrato. El runtime es JS (src/mcp/*.js) y los importa.

// El sobre que comparten TODAS las herramientas de lectura. Un agente aprende
// una sola forma y con eso puede citar sin adivinar: qué tan viejo es el dato
// (freshness), qué tiene de sospechoso (warnings) y qué NO se sabe y por qué
// (unknown). El tercero es lo que hace estructuralmente imposible inventar: una
// fecha que el portal no publica sale nombrada como ausente, nunca rellenada.

export const DATASET_KINDS = [
  'catalog',
  'mySchedule',
  'cart',
  'grades',
  'advisement',
  'holds',
  'enrollmentWindows',
  // La PVA (el Moodle) es la otra fuente. Sus datasets van con el mismo
  // prefijo que sus fuentes del orquestador, que es lo que escribe sync_log:
  // así una respuesta puede decir "esto lo leí del aula hace 4 minutos" sin
  // que nadie tenga que saber de dónde salió.
  'pvaCourses',
  'pvaContents',
  'pvaAssignments',
  'pvaSubmissions',
  'pvaGrades',
  'pvaCalendar',
  'pvaForums',
  'pvaNotifications',
  'pvaFiles',
] as const;
export type DatasetKind = (typeof DATASET_KINDS)[number];
export const datasetKindSchema = z.enum(DATASET_KINDS);

// neverSynced separa "no hay datos" de "nunca se leyó". Sin esa distinción un
// agente lee cero holds y afirma que no tenés holds, cuando la verdad puede ser
// que esa pantalla jamás se abrió.
export const freshnessSchema = z.object({
  kind: datasetKindSchema,
  syncedAt: z.string().nullable(),
  ageMinutes: z.number().nullable(),
  stale: z.boolean(),
  maxAgeMinutes: z.number().nullable(),
  neverSynced: z.boolean(),
});
export type Freshness = z.infer<typeof freshnessSchema>;

export const warningSchema = z.object({ kind: z.string(), detail: z.string() });
export const unknownFactSchema = z.object({ kind: z.string(), reason: z.string() });
export type Warning = z.infer<typeof warningSchema>;
export type UnknownFact = z.infer<typeof unknownFactSchema>;

export const envelopeFieldsSchema = z.object({
  asOf: z.string(),
  freshness: z.array(freshnessSchema),
  warnings: z.array(warningSchema),
  unknown: z.array(unknownFactSchema),
});

export function envelopeSchema<T extends z.ZodType>(data: T) {
  return envelopeFieldsSchema.extend({ data });
}

// De dónde salió un dato y con cuánta resolución. 'portal' es lo que PeopleSoft
// publicó, 'local' lo que el usuario cargó a mano, 'derived' lo que mikampus
// dedujo de un dato real. precision 'date' significa que no hay hora publicada:
// quien consuma esto no puede poner un recordatorio a hora fija encima.
// 'portal' es lo que publicó PeopleSoft y 'pva' lo que publicó el Moodle: son
// dos plataformas distintas y quien lo consuma tiene derecho a saber de cuál
// salió cada fecha.
export const sourceSchema = z.enum(['portal', 'pva', 'local', 'derived']);
export const precisionSchema = z.enum(['date', 'datetime']);
export type FactSource = z.infer<typeof sourceSchema>;

// ── El gancho de Kino ──────────────────────────────────────────────────────
// Kino es el gestor de tareas de Elias. Necesita exactamente dos cosas de
// mikampus: qué viene (para crear tareas y bloques) y qué lo está frenando
// (para avisar). Nada más. Por eso get_upcoming devuelve una lista PLANA de
// fechas, no el modelo académico: Kino no debería tener que entender qué es un
// STRM, una PRA ni un hold para poner un recordatorio.
//
// Las tres columnas que existen solo para Kino:
//   id        determinístico y estable entre corridas: es su llave de dedupe.
//             Formato: "class:<term>:<code>:<section>:<fecha>", "window:<term>:close",
//             "term:<term>:end". Volver a llamar no duplica tareas.
//   allDay    true cuando precision es 'date', o sea cuando NO hay hora
//             publicada. Kino no puede poner un recordatorio a hora fija sobre
//             eso sin inventar la hora. Hoy aplica al cierre de la ventana de
//             inscripción, que el portal publica como fecha pelada.
//   certainty 'published' lo dijo el portal; 'derived' lo dedujo mikampus. Un
//             derivado da contexto, no un recordatorio duro.
// revision es un hash del conjunto: un poll que devuelve la misma revisión no
// tiene nada que reescribir.
export const UPCOMING_KINDS = [
  'class',
  'term_start',
  'term_end',
  'enrollment_window_open',
  'enrollment_window_close',
  'scheduled_enroll',
  'watcher_appointment',
  // Las entregas del aula entran a la MISMA lista que las clases: son la misma
  // semana. Un gestor de tareas que reciba dos listas separadas tendría que
  // decidir por su cuenta cómo ordenarlas entre sí.
  'assign_due',
  'forum_due',
] as const;
export const upcomingKindSchema = z.enum(UPCOMING_KINDS);

export const upcomingItemSchema = z.object({
  id: z.string(),
  kind: upcomingKindSchema,
  title: z.string(),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  allDay: z.boolean(),
  precision: precisionSchema,
  source: sourceSchema,
  certainty: z.enum(['published', 'derived']),
  detail: z.string().nullable(),
  blocking: z.boolean(),
});
export type UpcomingItem = z.infer<typeof upcomingItemSchema>;

export const upcomingSchema = z.object({
  revision: z.string(),
  horizonDays: z.number().int(),
  generatedAt: z.string(),
  items: z.array(upcomingItemSchema),
});

export const BLOCKER_KINDS = [
  'hold',
  'enrollment_window_closing',
  'enrollment_window_closed',
  'cart_has_closed_sections',
  'nothing_enrolled',
  'stale_data',
  'never_synced',
  'agent_down',
  'monitoring_gap',
  'data_integrity',
] as const;
export const blockerKindSchema = z.enum(BLOCKER_KINDS);

export const blockerSchema = z.object({
  kind: blockerKindSchema,
  severity: z.enum(['alta', 'media', 'baja']),
  title: z.string(),
  detail: z.string(),
  since: z.string().nullable(),
  actionHint: z.string().nullable(),
});
export type Blocker = z.infer<typeof blockerSchema>;

export const upcomingEnvelopeSchema = envelopeSchema(upcomingSchema);
export const blockersEnvelopeSchema = envelopeSchema(z.object({ blockers: z.array(blockerSchema) }));

// ── Carril de acción ───────────────────────────────────────────────────────
// Una acción propuesta es una unión discriminada, no un objeto con campos
// opcionales: el tipo de acción decide qué datos hacen falta, y un enroll sin
// ciclo no debería ni compilar del lado del que la construya.
export const actionPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sync'), datasets: z.array(datasetKindSchema).min(1) }),
  z.object({
    kind: z.literal('add_to_cart'),
    term: z.string().min(1),
    career: z.string().min(1),
    courseNumber: z.string().min(1),
    classNbr: z.string().min(1),
    relatedClassNbr: z.string().nullable().default(null),
  }),
  z.object({ kind: z.literal('enroll_from_cart'), term: z.string().min(1) }),
  z.object({
    kind: z.literal('drop_class'),
    term: z.string().min(1),
    courseCode: z.string().min(1),
    classNbr: z.string().nullable().default(null),
  }),
  // La PVA. Un agente puede proponer una entrega, nunca hacerla: las tres
  // exigen el código que sale por push, y el nombre de la tarea lo escribe
  // Elias, no el modelo.
  z.object({
    kind: z.literal('pva_save_submission'),
    assignmentId: z.number().int(),
    assignmentName: z.string().min(1),
    body: z.string().min(1),
    confirmName: z.string().min(1),
  }),
  z.object({
    kind: z.literal('pva_submit_for_grading'),
    assignmentId: z.number().int(),
    assignmentName: z.string().min(1),
    confirmName: z.string().min(1),
    acceptStatement: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('pva_forum_reply'),
    postId: z.number().int(),
    discussionId: z.number().int().nullable().default(null),
    forumName: z.string().min(1),
    subject: z.string().default(''),
    message: z.string().min(1),
  }),
]);
export type ActionPayload = z.infer<typeof actionPayloadSchema>;

export const ACTION_KINDS = [
  'sync', 'add_to_cart', 'enroll_from_cart', 'drop_class',
  'pva_save_submission', 'pva_submit_for_grading', 'pva_forum_reply',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export const actionKindSchema = z.enum(ACTION_KINDS);

export const TICKET_STATES = ['pending', 'executed', 'failed', 'cancelled', 'expired'] as const;
export const ticketStateSchema = z.enum(TICKET_STATES);

export const ticketSchema = z.object({
  ticketId: z.string(),
  kind: actionKindSchema,
  summary: z.string(),
  effects: z.array(z.string()),
  reversible: z.boolean(),
  requiresCode: z.boolean(),
  deliveredVia: z.array(z.string()),
  state: ticketStateSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type Ticket = z.infer<typeof ticketSchema>;


// ── La PVA (Moodle) ────────────────────────────────────────────────────────
// El aula es una fuente distinta de MiCampus y contesta preguntas distintas.
// La confusión cara, y por eso está en el tipo y no solo en la documentación:
// la nota de la PVA es la del AULA (lo que el profesor puso en su libro) y la
// de MiCampus es la OFICIAL del expediente. No son la misma y no tienen por
// qué coincidir.

export const pvaCourseSchema = z.object({
  courseId: z.number().int(),
  shortname: z.string(),
  fullname: z.string(),
  progress: z.number().nullable(),
  lastAccessAt: z.string().nullable(),
  // El libro puede existir y no ser legible: showGrades es la precondición del
  // sitio y reachable es lo que dijo la última llamada.
  gradebook: z.object({
    showGrades: z.boolean(),
    reachable: z.boolean().nullable(),
    errorcode: z.string().nullable(),
    total: z.string().nullable(),
  }),
  assignments: z.object({ total: z.number().int(), submitted: z.number().int(), graded: z.number().int(), openNow: z.number().int() }),
  contentsSyncedAt: z.string().nullable(),
  sections: z.number().int().nullable(),
  modules: z.number().int().nullable(),
});

export const pvaDueItemSchema = z.object({
  // Estable entre corridas: es la llave de dedupe de quien lo consuma.
  id: z.string(),
  kind: z.enum(['assign_due', 'forum_due', 'event']),
  courseId: z.number().int().nullable(),
  courseShortname: z.string().nullable(),
  title: z.string(),
  dueAt: z.string(),
  localDay: z.string().nullable(),
  cmid: z.number().int().nullable(),
  assignmentId: z.number().int().nullable(),
  url: z.string().nullable(),
  overdue: z.boolean(),
  submitted: z.boolean().nullable(),
  graded: z.boolean().nullable(),
  // null cuando no hay entrega que mirar (un foro con fecha, por ejemplo).
  status: z.string().nullable(),
});

export const pvaAssignmentDetailSchema = z.object({
  assignmentId: z.number().int(),
  cmid: z.number().int(),
  courseId: z.number().int(),
  courseShortname: z.string().nullable(),
  name: z.string(),
  intro: z.string().nullable(),
  opensAt: z.string().nullable(),
  dueAt: z.string().nullable(),
  cutoffAt: z.string().nullable(),
  extensionAt: z.string().nullable(),
  gradeMax: z.number(),
  submission: z
    .object({
      status: z.string(),
      attempt: z.number().int(),
      submittedAt: z.string().nullable(),
      gradingStatus: z.string(),
      canEdit: z.boolean(),
      isLate: z.boolean(),
      isOverdue: z.boolean(),
      acceptsLate: z.boolean(),
      closedForever: z.boolean(),
    })
    .nullable(),
  grade: z
    .object({
      value: z.number().nullable(),
      raw: z.string().nullable(),
      display: z.string().nullable(),
      gradedAt: z.string().nullable(),
      comment: z.string().nullable(),
    })
    .nullable(),
});

export const pvaGradeItemSchema = z.object({
  itemId: z.number().int(),
  name: z.string().nullable(),
  itemtype: z.string(),
  cmid: z.number().int().nullable(),
  isGradable: z.boolean(),
  // El texto es el dato: el número derivado pierde el centinela del servidor.
  raw: z.string().nullable(),
  display: z.string(),
  range: z.string(),
  percentage: z.string(),
  gradedAt: z.string().nullable(),
  hidden: z.boolean(),
  feedback: z.string().nullable(),
});

export const pvaAnnouncementSchema = z.object({
  kind: z.enum(['anuncio', 'tarea_por_vencer', 'otro']),
  notificationId: z.number().int().nullable(),
  courseId: z.number().int().nullable(),
  courseShortname: z.string().nullable(),
  subject: z.string(),
  contextName: z.string().nullable(),
  url: z.string().nullable(),
  createdAt: z.string(),
  readInPortal: z.boolean(),
});

export const pvaModuleFileSchema = z.object({
  fileId: z.number().int(),
  filename: z.string(),
  mimetype: z.string().nullable(),
  // El tamaño DECLARADO por la PVA: mod_page reporta 0 con cuerpo real, así
  // que un 0 acá no significa vacío.
  declaredBytes: z.number().int(),
  downloaded: z.boolean(),
  indexed: z.boolean(),
  // Por qué no se indexó, cuando no se indexó. Es lo que evita que una
  // búsqueda vacía parezca "no está en tus materiales".
  notIndexedReason: z.string().nullable(),
});

export const pvaModuleSchema = z.object({
  cmid: z.number().int(),
  modname: z.string(),
  name: z.string(),
  url: z.string().nullable(),
  // true = se pinta en la página del curso y no se abre (los label).
  inlineOnly: z.boolean(),
  purpose: z.string().nullable(),
  description: z.string().nullable(),
  completion: z.enum(['sin_seguimiento', 'pendiente', 'hecho']),
  dates: z.array(z.object({ kind: z.string(), at: z.string(), label: z.string().nullable() })),
  files: z.array(pvaModuleFileSchema),
  links: z.array(z.object({ name: z.string(), url: z.string(), host: z.string() })),
});

export const pvaFileHitSchema = z.object({
  fileId: z.number().int(),
  filename: z.string(),
  courseId: z.number().int(),
  courseShortname: z.string().nullable(),
  cmid: z.number().int(),
  moduleName: z.string().nullable(),
  extractor: z.string(),
  pages: z.number().int().nullable(),
  // El fragmento con el término marcado, tal como lo arma el índice.
  snippet: z.string(),
});

export const pvaSectionSchema = z.object({
  sectionId: z.number().int(),
  number: z.number().int(),
  name: z.string(),
  summary: z.string().nullable(),
  modules: z.array(pvaModuleSchema),
});

export const pvaCoursesEnvelopeSchema = envelopeSchema(z.object({ courses: z.array(pvaCourseSchema) }));
export const pvaDueEnvelopeSchema = envelopeSchema(
  z.object({ horizonDays: z.number().int(), items: z.array(pvaDueItemSchema) })
);
export const pvaAssignmentEnvelopeSchema = envelopeSchema(
  z.object({ assignment: pvaAssignmentDetailSchema.nullable(), matches: z.array(z.object({ assignmentId: z.number().int(), name: z.string() })) })
);
export const pvaGradesEnvelopeSchema = envelopeSchema(
  z.object({
    courseId: z.number().int(),
    courseShortname: z.string().nullable(),
    total: z.string().nullable(),
    reachable: z.boolean(),
    items: z.array(pvaGradeItemSchema),
  })
);
export const pvaAnnouncementsEnvelopeSchema = envelopeSchema(
  z.object({ items: z.array(pvaAnnouncementSchema), unreadInPortal: z.number().int().nullable() })
);
export const pvaSearchEnvelopeSchema = envelopeSchema(
  z.object({
    query: z.string(),
    hits: z.array(pvaFileHitSchema),
    // Cuántos materiales hay y cuántos se pueden buscar de verdad: sin esto,
    // cero resultados es indistinguible de cero archivos indexados.
    corpus: z.object({ files: z.number().int(), downloaded: z.number().int(), indexed: z.number().int() }),
  })
);
// Un material del aula leído entero. `chars` es el largo del texto COMPLETO, no
// del fragmento devuelto: sin él, un texto cortado por `maxChars` es
// indistinguible de un documento que se acabó ahí.
export const pvaFileSchema = z.object({
  fileId: z.number().int(),
  filename: z.string(),
  courseId: z.number().int(),
  courseShortname: z.string().nullable(),
  cmid: z.number().int(),
  moduleName: z.string().nullable(),
  mimetype: z.string().nullable(),
  // null mientras el material no se haya descargado.
  extractor: z.string().nullable(),
  pages: z.number().int().nullable(),
  chars: z.number().int(),
});

export const pvaFileEnvelopeSchema = envelopeSchema(
  z.object({
    file: pvaFileSchema.nullable(),
    text: z.string(),
    offset: z.number().int(),
    // Desde dónde pedir la continuación, o null cuando no queda nada más.
    nextOffset: z.number().int().nullable(),
    matches: z.array(
      z.object({ fileId: z.number().int(), filename: z.string(), courseShortname: z.string().nullable() })
    ),
  })
);

export const pvaSectionsEnvelopeSchema = envelopeSchema(
  z.object({ courseId: z.number().int(), courseShortname: z.string().nullable(), sections: z.array(pvaSectionSchema) })
);
