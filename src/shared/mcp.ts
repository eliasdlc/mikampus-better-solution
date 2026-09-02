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
export const sourceSchema = z.enum(['portal', 'local', 'derived']);
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
]);
export type ActionPayload = z.infer<typeof actionPayloadSchema>;

export const ACTION_KINDS = ['sync', 'add_to_cart', 'enroll_from_cart', 'drop_class'] as const;
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
