import {
  appStateSchema,
  cartResponseSchema,
  catalogResponseSchema,
  catalogCourseSchema,
  planDetailSchema,
  planSummarySchema,
  planToCartResultSchema,
  recommendationOptionsResponseSchema,
  degreePathResponseSchema,
  type DegreePathResponse,
  scheduleResponseSchema,
  termInfoSchema,
  termContextSchema,
  gradesResponseSchema,
  pensumResponseSchema,
  requirementsResponseSchema,
  profileResponseSchema,
  type RequirementsResponse,
  type ProfileResponse,
  holdsResponseSchema,
  goalsResponseSchema,
  insightsResponseSchema,
  accountInfoSchema,
  cartValidationResponseSchema,
  enrollmentWindowsResponseSchema,
  dropResultSchema,
  type AccountInfo,
  type GoalsResponse,
  type InsightsResponse,
  type CartValidationResponse,
  type EnrollmentWindowsResponse,
  type DropResult,
  type AppState,
  type CartResponse,
  type CatalogResponse,
  type PlanDetail,
  type PlanSummary,
  type PlanToCartResult,
  type RecommendationOptionsResponse,
  type RecommendationStrategy,
  type ScheduleResponse,
  type TermInfo,
  type TermContext,
  type GradesResponse,
  type PensumResponse,
  type HoldsResponse,
  mesaResponseSchema,
  mesaSolveResponseSchema,
  termPhaseResponseSchema,
  termEventsResponseSchema,
  type TermEventInput,
  type TermEventsResponse,
  type MesaResponse,
  type MesaSolveResponse,
  type ScheduleConstraintsInput,
  type TermPhaseResponse,
} from '../../../src/shared/schemas.ts';
import { z } from 'zod';

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

// Todas las respuestas del backend se validan contra los esquemas Zod
// compartidos: si un scraper devolvió basura, el error aparece acá con nombre,
// no como un render roto tres componentes más abajo.
async function getJSON(url: string): Promise<unknown> {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error || `HTTP ${res.status}`, res.status);
  return data;
}

async function send(url: string, method: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error || `HTTP ${res.status}`, res.status);
  return data;
}

// ── Web Push (§5.5) ─────────────────────────────────────────────────────────
export async function fetchVapidKey(): Promise<string | null> {
  const data = (await getJSON('/api/push/vapid-key')) as { publicKey: string | null };
  return data.publicKey ?? null;
}

export async function subscribePush(subscription: PushSubscriptionJSON): Promise<void> {
  await send('/api/push/subscribe', 'POST', { subscription });
}

export async function unsubscribePush(endpoint: string): Promise<void> {
  await send('/api/push/unsubscribe', 'POST', { endpoint });
}

// Desde cache (<10ms). El refresh contra el portal es syncCart y es explícito.
export async function fetchCart(): Promise<CartResponse> {
  return cartResponseSchema.parse(await getJSON('/api/cart'));
}

export async function syncCart(): Promise<CartResponse> {
  return cartResponseSchema.parse(await send('/api/cart/sync', 'POST'));
}

// Quita una fila del carrito EN EL PORTAL: son segundos de Playwright, no una
// edición local. El NRC manda sobre el índice de la fila porque el índice se
// renumera en cuanto sale una materia.
export async function removeCartRow(input: { classNbr?: string | null; courseCode?: string | null }): Promise<CartResponse> {
  return cartResponseSchema.parse(await send('/api/cart/remove', 'POST', input));
}

export async function validateCart(): Promise<CartValidationResponse> {
  return cartValidationResponseSchema.parse(await send('/api/cart/validate', 'POST'));
}

export async function fetchEnrollmentWindows(term?: string): Promise<EnrollmentWindowsResponse> {
  const qs = term ? `?term=${encodeURIComponent(term)}` : '';
  return enrollmentWindowsResponseSchema.parse(await getJSON(`/api/enrollment-windows${qs}`));
}

export async function syncEnrollmentWindows(term?: string): Promise<EnrollmentWindowsResponse> {
  return enrollmentWindowsResponseSchema.parse(
    await send('/api/enrollment-windows/sync', 'POST', term ? { term } : undefined)
  );
}

export async function fetchState(): Promise<AppState> {
  return appStateSchema.parse(await getJSON('/api/state'));
}

export async function fetchCatalog(): Promise<CatalogResponse> {
  return catalogResponseSchema.parse(await getJSON('/api/catalog'));
}

// "Ver más grupos": relee UNA materia del portal y persiste sus secciones en el
// catálogo local. Tarda segundos (es Playwright) y devuelve la materia ya
// reconstruida desde disco, con todos sus grupos.
const courseSyncResultSchema = z.object({
  term: z.string(),
  courseCode: z.string(),
  saved: z.number(),
  course: catalogCourseSchema.nullable(),
});
export type CourseSyncResult = z.infer<typeof courseSyncResultSchema>;

export async function syncCourseSections(input: {
  term: string;
  courseCode: string;
  career?: string | null;
}): Promise<CourseSyncResult> {
  return courseSyncResultSchema.parse(
    await send('/api/catalog/course/sync', 'POST', {
      term: input.term,
      courseCode: input.courseCode,
      career: input.career ?? 'GRDO',
    })
  );
}

// Mi Horario, desde cache. Ojo: /api/schedule es el scheduler de inscripción,
// otra cosa; el horario inscrito vive en /api/my-schedule.
export async function fetchMySchedule(term?: string): Promise<ScheduleResponse> {
  const qs = term ? `?term=${encodeURIComponent(term)}` : '';
  return scheduleResponseSchema.parse(await getJSON(`/api/my-schedule${qs}`));
}

// Refresh en vivo contra PeopleSoft: tarda segundos y publica su progreso en
// el feed SSE. La UI no se bloquea esperándolo. `termLabel` es la ETIQUETA del
// ciclo a sincronizar ("Abril de 2026") — View My Classes lista los ciclos por
// etiqueta, no por STRM. Sin ella, el server toma el ciclo que el portal ponga
// primero (el actual).
export async function syncMySchedule(termLabel?: string): Promise<ScheduleResponse> {
  return scheduleResponseSchema.parse(
    await send('/api/my-schedule/sync', 'POST', termLabel ? { term: termLabel } : undefined)
  );
}

// ── Plazos de baja por clase ────────────────────────────────────────────────
// Tres fechas por NRC que contestan lo único que el calendario institucional no
// puede: si das de baja HOY, ¿queda en tu récord? Salen de la pantalla
// "Enrollment Deadlines" del portal, que las publica por clase y por sesión.

const dropDeadlinesSchema = z.object({
  term: z.string().nullable(),
  classes: z.array(
    z.object({
      classNbr: z.string(),
      session: z.string(),
      deleteBy: z.string().nullable(),
      retainBy: z.string().nullable(),
      penaltyFrom: z.string().nullable(),
      updatedAt: z.string().nullable(),
    })
  ),
  syncedAt: z.string().nullable(),
});
export type DropDeadlines = z.infer<typeof dropDeadlinesSchema>;

export async function fetchDropDeadlines(term?: string): Promise<DropDeadlines> {
  const qs = term ? `?term=${encodeURIComponent(term)}` : '';
  return dropDeadlinesSchema.parse(await getJSON(`/api/my-schedule/drop-deadlines${qs}`));
}

// Cuesta una navegación por clase inscrita, así que nunca es automático: lo
// pide la persona y el banner dice lo que tarda.
export async function syncDropDeadlines(term?: string): Promise<DropDeadlines> {
  return dropDeadlinesSchema.parse(
    await send('/api/my-schedule/drop-deadlines/sync', 'POST', term ? { term } : undefined)
  );
}

export async function dropScheduleCourse(input: {
  term: string;
  courseCode: string;
  classNbr?: string | null;
  confirmCode: string;
}): Promise<DropResult> {
  return dropResultSchema.parse(await send('/api/my-schedule/drop', 'POST', input));
}

export function scheduleAt(input: { atISO: string; term?: string; consent?: boolean }) {
  return send('/api/schedule', 'POST', input);
}
export function cancelSchedule() {
  return send('/api/schedule', 'DELETE');
}
// Qué mira el watcher: el cupo de TU sección, los grupos nuevos que abra la
// universidad, o las dos cosas. Ver src/scheduler.js para por qué "groups" no
// puede auto-inscribir.
export type WatcherScope = 'seats' | 'groups' | 'both';

export function setWatcher(input: {
  enabled: boolean;
  autoEnroll?: boolean;
  appointmentAt?: string | null;
  term?: string;
  consent?: boolean;
  scope?: WatcherScope;
  intervalMs?: number;
}) {
  return send('/api/watch', 'POST', input);
}

// Solo el ritmo. Va por PATCH y no por POST porque cambiar cada cuánto se
// consulta no enciende nada ni pide autorización nueva: se puede ajustar con el
// watcher apagado y queda guardado para la próxima vez que lo prendas.
export async function setWatcherInterval(intervalMs: number): Promise<AppState> {
  const data = await send('/api/watch', 'PATCH', { intervalMs });
  return appStateSchema.parse((data as { state: unknown }).state);
}
export function enrollNow() {
  return send('/api/enroll', 'POST');
}

// Reusa el endpoint existente: reabre la búsqueda en vivo y clickea "Select"
// para esa sección. term/career/courseNumber salen del catálogo cacheado.
export function addToCart(input: {
  term: string;
  career: string;
  courseNumber: string;
  classNbr: string;
  relatedClassNbr?: string | null;
}) {
  return send('/api/search/add', 'POST', input) as Promise<{ ok?: boolean; alreadyInCart?: boolean }>;
}

// ── Planes ──────────────────────────────────────────────────────────────────
// CRUD contra SQLite: instantáneo, sin portal. La única operación viva es
// sendPlanToCart, que tarda segundos por materia y publica su progreso en SSE.

// La lista de términos conocidos, ya resueltos contra hoy. El planner filtra a
// los plannable (hasSections); el resto de la app suele querer el contexto.
export async function fetchTerms(): Promise<TermInfo[]> {
  const data = await getJSON('/api/terms');
  return z.object({ terms: z.array(termInfoSchema) }).parse(data).terms;
}

// El contexto de tiempo: la lista + cuál ciclo corre hoy y cuál sigue. Lo leen
// el Dashboard y /horario para no mezclar ciclos.
export async function fetchTermContext(): Promise<TermContext> {
  return termContextSchema.parse(await getJSON('/api/terms'));
}

export async function fetchPlans(): Promise<PlanSummary[]> {
  const data = await getJSON('/api/plans');
  return z.object({ plans: z.array(planSummarySchema) }).parse(data).plans;
}

export async function fetchPlan(id: number): Promise<PlanDetail> {
  return planDetailSchema.parse(await getJSON(`/api/plans/${id}`));
}

export async function createPlan(input: { term: string; name: string }): Promise<PlanDetail> {
  return planDetailSchema.parse(await send('/api/plans', 'POST', input));
}

export async function renamePlan(id: number, name: string): Promise<PlanDetail> {
  return planDetailSchema.parse(await send(`/api/plans/${id}`, 'PATCH', { name }));
}

export function deletePlan(id: number) {
  return send(`/api/plans/${id}`, 'DELETE');
}

export async function duplicatePlan(id: number): Promise<PlanDetail> {
  return planDetailSchema.parse(await send(`/api/plans/${id}/duplicate`, 'POST'));
}

// `relatedSectionId` es la práctica del grupo. El backend la soporta desde que
// existe el par en plan_items; el cliente no la exponía, así que ninguna
// pantalla podía elegirla y el portal terminaba marcando la primera del listado.
export async function addPlanItem(
  planId: number,
  input: { courseId: number; sectionId?: number | null; relatedSectionId?: number | null; note?: string | null }
): Promise<PlanDetail> {
  return planDetailSchema.parse(await send(`/api/plans/${planId}/items`, 'POST', input));
}

export async function updatePlanItem(
  planId: number,
  itemId: number,
  patch: { sectionId?: number | null; relatedSectionId?: number | null; note?: string | null; locked?: boolean }
): Promise<PlanDetail> {
  return planDetailSchema.parse(await send(`/api/plans/${planId}/items/${itemId}`, 'PATCH', patch));
}

export async function removePlanItem(planId: number, itemId: number): Promise<PlanDetail> {
  return planDetailSchema.parse(await send(`/api/plans/${planId}/items/${itemId}`, 'DELETE'));
}

export async function sendPlanToCart(planId: number): Promise<PlanToCartResult> {
  return planToCartResultSchema.parse(await send(`/api/plans/${planId}/to-cart`, 'POST'));
}

// ── Metas y señales (/academico, Fase 10) ───────────────────────────────────
export async function fetchGoals(): Promise<GoalsResponse> {
  return goalsResponseSchema.parse(await getJSON('/api/goals'));
}

export async function createGoal(input: { target: number; deadlineTerm?: string | null }): Promise<GoalsResponse> {
  return goalsResponseSchema.parse(await send('/api/goals', 'POST', input));
}

export async function updateGoal(
  id: number,
  input: { target?: number; deadlineTerm?: string | null }
): Promise<GoalsResponse> {
  return goalsResponseSchema.parse(await send(`/api/goals/${id}`, 'PATCH', input));
}

export async function deleteGoal(id: number): Promise<GoalsResponse> {
  return goalsResponseSchema.parse(await send(`/api/goals/${id}`, 'DELETE'));
}

export async function fetchInsights(): Promise<InsightsResponse> {
  return insightsResponseSchema.parse(await getJSON('/api/insights'));
}

// ── Recomendador de ciclo ───────────────────────────────────────────────────
// Devuelve las DOS propuestas (ponerse al día / avanzar) del mismo ciclo: cuál
// conviene depende de si pesa más no arrastrar deudas o no atrasar la
// graduación, y eso no lo decide el algoritmo.
export type RecommendationControls = {
  maxCredits: number;
  include?: string[];
  exclude?: string[];
};

function controlsToQuery(controls: RecommendationControls): Record<string, string> {
  return {
    maxCredits: String(controls.maxCredits),
    ...(controls.include?.length ? { include: controls.include.join(',') } : {}),
    ...(controls.exclude?.length ? { exclude: controls.exclude.join(',') } : {}),
  };
}

// La ruta a graduación: cuántos ciclos faltan colocando lo pendiente en el
// tiempo, y qué restricción fija esa fecha. Todo se calcula en el backend sin
// tocar el portal, así que pedirla es barato y no encola nada.
export async function fetchDegreePath(maxCredits: number): Promise<DegreePathResponse> {
  const qs = new URLSearchParams({ maxCredits: String(maxCredits) });
  return degreePathResponseSchema.parse(await getJSON(`/api/degree-path?${qs}`));
}

export async function fetchRecommendation(
  term: string,
  controls: RecommendationControls
): Promise<RecommendationOptionsResponse> {
  const qs = new URLSearchParams({ term, ...controlsToQuery(controls) });
  return recommendationOptionsResponseSchema.parse(await getJSON(`/api/recommendation?${qs}`));
}

export async function createRecommendedPlan(
  input: { term: string; name?: string; strategy: RecommendationStrategy } & RecommendationControls
): Promise<PlanDetail> {
  return planDetailSchema.parse(
    await send('/api/recommendation/plan', 'POST', {
      term: input.term,
      name: input.name,
      strategy: input.strategy,
      maxCredits: input.maxCredits,
      include: input.include?.join(',') ?? '',
      exclude: input.exclude?.join(',') ?? '',
    })
  );
}

// ── Notas, pénsum y holds ───────────────────────────────────────────────────

export async function fetchGrades(): Promise<GradesResponse> {
  return gradesResponseSchema.parse(await getJSON('/api/grades'));
}

// Va en vivo contra el portal (dos cargas: el histórico y los totales para
// contrastarlos). Tarda; la pantalla sigue mostrando lo cacheado mientras tanto.
export async function syncGrades(): Promise<GradesResponse> {
  return gradesResponseSchema.parse(await send('/api/grades/sync', 'POST'));
}

export async function fetchPensum(term?: string): Promise<PensumResponse> {
  const qs = term ? `?term=${encodeURIComponent(term)}` : '';
  return pensumResponseSchema.parse(await getJSON(`/api/pensum${qs}`));
}

// El árbol de requisitos: período → obligatorios/electivas → cursos, con el
// courseId del catálogo y "offered" ya cruzados en el server.
export async function fetchRequirements(term?: string): Promise<RequirementsResponse> {
  const qs = term ? `?term=${encodeURIComponent(term)}` : '';
  return requirementsResponseSchema.parse(await getJSON(`/api/requirements${qs}`));
}

export async function fetchProfile(): Promise<ProfileResponse> {
  return profileResponseSchema.parse(await getJSON('/api/profile'));
}

// Los códigos de tu carrera (pénsum + inscritas): acotan la búsqueda a lo tuyo.
export async function fetchPensumCodes(): Promise<string[]> {
  const { codes } = z.object({ codes: z.array(z.string()) }).parse(await getJSON('/api/pensum/codes'));
  return codes;
}

// El informe de avance lo genera el portal al vuelo: es la operación más lenta
// de la app (~30s). Ahora reconstruye el árbol entero y deriva el pénsum.
export async function syncPensum(): Promise<{ ok: boolean; groups: number; courses: number; pensum: number }> {
  return z
    .object({ ok: z.boolean(), groups: z.number(), courses: z.number(), pensum: z.number() })
    .parse(await send('/api/pensum/sync', 'POST'));
}

export async function fetchHolds(): Promise<HoldsResponse> {
  return holdsResponseSchema.parse(await getJSON('/api/holds'));
}

export async function syncHolds(): Promise<HoldsResponse> {
  return holdsResponseSchema.parse(await send('/api/holds/sync', 'POST'));
}

// ── Cuenta ───────────────────────────────────────────────────────────────────
// La contraseña nunca vuelve del backend: fetchAccount solo trae el usuario.
export async function fetchAccount(): Promise<AccountInfo> {
  return accountInfoSchema.parse(await getJSON('/api/account'));
}

// Guardar cambia la cuenta en caliente: el backend tira la sesión y limpia el
// cache personal. Devuelve la cuenta nueva ya vigente.
export async function saveAccount(input: { username: string; password: string }): Promise<AccountInfo> {
  const data = await send('/api/account', 'POST', input);
  return accountInfoSchema.parse((data as { account?: unknown }).account);
}

// ── Sesión local ───────────────────────────────────────────────────────────

const authMeSchema = z.object({
  mode: z.literal('local'),
  user: z.object({ id: z.number(), username: z.string() }).nullable(),
  csrfToken: z.string().nullable(),
});
export type AuthMe = z.infer<typeof authMeSchema>;

export async function fetchAuthMe(): Promise<AuthMe> {
  return authMeSchema.parse(await getJSON('/api/auth/me'));
}

export async function login(input: { username: string; password: string }) {
  const data = await send('/api/auth/login', 'POST', input);
  return z
    .object({ ok: z.literal(true), user: z.object({ id: z.number(), username: z.string() }), csrfToken: z.string(), expiresAt: z.string() })
    .parse(data);
}

export async function logout() {
  return z.object({ ok: z.literal(true) }).parse(await send('/api/auth/logout', 'POST'));
}

const accountOverviewSchema = z.object({
  user: z.object({ id: z.number(), portalUsername: z.string().nullable(), createdAt: z.string(), lastLoginAt: z.string().nullable() }).nullable(),
  credential: z
    .object({ username: z.string(), reason: z.string().nullable(), expiresAt: z.string(), createdAt: z.string() })
    .nullable(),
  syncs: z.array(z.object({ kind: z.string(), label: z.string(), syncedAt: z.string().nullable() })),
});
export type AccountOverview = z.infer<typeof accountOverviewSchema>;

export async function fetchAccountOverview(): Promise<AccountOverview> {
  return accountOverviewSchema.parse(await getJSON('/api/account/overview'));
}

const actionsSchema = z.object({
  actions: z.array(
    z.object({
      id: z.number(),
      action: z.string(),
      detail: z.string().nullable(),
      portalResponse: z.string().nullable(),
      ok: z.boolean().nullable(),
      createdAt: z.string(),
    })
  ),
});
export type AccountAction = z.infer<typeof actionsSchema>['actions'][number];

export async function fetchActions(): Promise<AccountAction[]> {
  return actionsSchema.parse(await getJSON('/api/actions')).actions;
}

export async function deleteAllMyData(input?: { keepBackups?: boolean }) {
  return z
    .object({ ok: z.literal(true), removed: z.array(z.string()).default([]), note: z.string().optional() })
    .parse(await send('/api/account/data', 'DELETE', input ?? {}));
}

// ── Onboarding (Fase 4): corre antes de que exista sesión ───────────────────

const onboardingSchema = z.object({
  step: z.enum(['mode', 'prerequisites', 'browser', 'credentials', 'done']),
  completedAt: z.string().nullable(),
  mode: z.enum(['desktop', 'home-server']).nullable(),
  modes: z.array(z.object({ id: z.string(), label: z.string(), summary: z.string(), guarantees: z.array(z.string()) })),
  prerequisites: z.array(z.object({ id: z.string(), label: z.string(), ok: z.boolean(), detail: z.string() })),
  browser: z.object({
    installed: z.boolean(),
    root: z.string(),
    source: z.enum(['system', 'managed']).nullable(),
    install: z.object({
      status: z.enum(['idle', 'running', 'done', 'error']),
      percent: z.number(),
      message: z.string().nullable(),
      error: z.string().nullable(),
    }),
  }),
  account: z.boolean(),
});
export type OnboardingState = z.infer<typeof onboardingSchema>;

export async function fetchOnboarding(): Promise<OnboardingState> {
  return onboardingSchema.parse(await getJSON('/api/onboarding'));
}

export async function chooseRuntimeMode(mode: 'desktop' | 'home-server') {
  return send('/api/onboarding/mode', 'POST', { mode });
}

export async function startBrowserInstall() {
  return send('/api/onboarding/browser', 'POST');
}

export async function completeOnboarding() {
  return send('/api/onboarding/complete', 'POST');
}

// ── Estado permanente del agente (Fase 4 §3) ────────────────────────────────

const statusSchema = z.object({
  now: z.string(),
  agent: z.object({
    running: z.boolean(),
    pid: z.number().nullable(),
    port: z.number().nullable(),
    startedAt: z.string().nullable(),
    version: z.string(),
  }),
  mode: z.enum(['desktop', 'home-server']),
  schema: z.object({ version: z.number(), applied: z.array(z.number()), migratedFrom: z.number(), preUpgradeBackup: z.string().nullable() }),
  watcher: z
    .object({
      status: z.string(),
      lastCheckAt: z.string().nullable(),
      nextCheckAt: z.string().nullable(),
      consecutiveFailures: z.number(),
      pauseReason: z.string().nullable(),
      autoEnroll: z.boolean(),
      appointmentAt: z.string().nullable(),
      scope: z.enum(['seats', 'groups', 'both']),
    })
    .nullable(),
  schedule: z.object({ atISO: z.string(), state: z.string(), lastError: z.string().nullable() }).nullable(),
  monitoringGap: z
    .object({
      from: z.string(),
      to: z.string(),
      ms: z.number(),
      // Cuántos watchers quedaron a oscuras. Sin al menos uno, el backend no
      // manda el hueco: un corte sin nada vigilándose no le costó un cupo a nadie.
      watchers: z.number().default(1),
      detail: z.string().nullable(),
    })
    .nullable(),
  credential: z.object({ reason: z.string().nullable(), expiresAt: z.string(), store: z.string() }).nullable(),
  backup: z.object({
    lastSuccessfulAt: z.string().nullable(),
    nextRunAt: z.string().nullable(),
    due: z.boolean(),
    keep: z.number(),
    directory: z.string(),
    copies: z.array(z.object({ name: z.string(), path: z.string(), bytes: z.number(), at: z.string(), kind: z.string() })),
    sameDiskWarning: z.string(),
  }),
  update: z.object({
    policy: z.enum(['manual', 'off']),
    lastCheck: z
      .object({ status: z.string(), current: z.string(), latest: z.string().nullable().optional(), url: z.string().nullable().optional(), checkedAt: z.string().optional(), error: z.string().optional() })
      .nullable(),
    inProgress: z.unknown().nullable(),
  }),
  power: z.object({ mustStayAwake: z.boolean(), note: z.string() }),
});
export type AgentStatus = z.infer<typeof statusSchema>;

export async function fetchStatus(): Promise<AgentStatus> {
  return statusSchema.parse(await getJSON('/api/status'));
}

// ── Notificaciones: feed durable y adaptadores externos ─────────────────────

const feedSchema = z.object({
  items: z.array(
    z.object({
      id: z.number(),
      key: z.string(),
      title: z.string(),
      body: z.string(),
      urgency: z.string(),
      link: z.string().nullable(),
      createdAt: z.string(),
      readAt: z.string().nullable(),
    })
  ),
  unread: z.number(),
});
export type NotificationFeed = z.infer<typeof feedSchema>;

export async function fetchNotifications(): Promise<NotificationFeed> {
  return feedSchema.parse(await getJSON('/api/notifications'));
}

export async function markNotificationsRead() {
  return send('/api/notifications/read', 'POST');
}

const channelsSchema = z.object({
  channels: z.array(
    z.object({
      id: z.number(),
      kind: z.string(),
      label: z.string(),
      destination: z.string(),
      enabled: z.boolean(),
      external: z.boolean(),
      dependency: z.string().nullable(),
      lastTestAt: z.string().nullable(),
      lastError: z.string().nullable(),
      payloadSample: z.object({ title: z.string(), body: z.string(), urgency: z.string(), link: z.string().nullable() }),
    })
  ),
  adapters: z.array(z.object({ kind: z.string(), label: z.string(), external: z.boolean(), dependency: z.string().nullable() })),
});
export type ChannelsResponse = z.infer<typeof channelsSchema>;

export async function fetchChannels(): Promise<ChannelsResponse> {
  return channelsSchema.parse(await getJSON('/api/notifications/channels'));
}

export async function createChannel(input: { kind: string; label?: string; destination: string }) {
  return send('/api/notifications/channels', 'POST', input);
}

export async function toggleChannel(id: number, enabled: boolean) {
  return send(`/api/notifications/channels/${id}`, 'PATCH', { enabled });
}

export async function removeChannel(id: number) {
  return send(`/api/notifications/channels/${id}`, 'DELETE');
}

export async function testNotificationChannel(id: number) {
  return z
    .object({ ok: z.boolean(), error: z.string().optional() })
    .parse(await send(`/api/notifications/channels/${id}/test`, 'POST'));
}

// ── Copias, diagnósticos y updates ──────────────────────────────────────────

export async function createBackupNow() {
  return send('/api/backups', 'POST');
}

export async function setBackupRetention(keep: number) {
  return send('/api/backups', 'PATCH', { keep });
}

export async function exportBackupTo(directory: string) {
  return z
    .object({ file: z.string(), bytes: z.number(), schema: z.number(), sameDisk: z.boolean() })
    .parse(await send('/api/backups/export', 'POST', { directory }));
}

const diagnosticsSchema = z.object({
  files: z.array(z.object({ name: z.string(), bytes: z.number(), at: z.string(), pii: z.boolean() })),
  note: z.string(),
});

export async function fetchDiagnostics() {
  return diagnosticsSchema.parse(await getJSON('/api/diagnostics'));
}

export async function exportDiagnosticsTo(directory: string) {
  return send('/api/diagnostics/export', 'POST', { directory });
}

export async function checkForUpdate() {
  return z
    .object({ status: z.string(), current: z.string(), latest: z.string().nullable().optional(), url: z.string().nullable().optional(), error: z.string().optional() })
    .parse(await send('/api/updates/check', 'POST'));
}

export async function setUpdatePolicy(policy: 'manual' | 'off') {
  return send('/api/updates', 'PATCH', { policy });
}

const erasePreviewSchema = z.object({
  targets: z.array(
    z.object({ id: z.string(), label: z.string(), path: z.string(), purpose: z.string(), exists: z.boolean(), bytes: z.number(), keepable: z.boolean(), runtimeSafe: z.boolean() })
  ),
  external: z.array(z.object({ id: z.string(), label: z.string(), purpose: z.string() })),
  outsideReach: z.array(z.object({ id: z.string(), label: z.string(), purpose: z.string() })),
  totalBytes: z.number(),
  note: z.string(),
});
export type ErasePreview = z.infer<typeof erasePreviewSchema>;

export async function fetchErasePreview(): Promise<ErasePreview> {
  return erasePreviewSchema.parse(await getJSON('/api/account/erase-preview'));
}

// ── Sincronización universal (P1) ───────────────────────────────────────────
// Una sola definición de frescura para toda la app. El estado es barato (sale
// de SQLite) y dice por qué cada fuente está como está; correr es lo único que
// puede salir al portal.

const syncResultSchema = z.object({
  key: z.string(),
  label: z.string(),
  status: z.enum(['fresh', 'updated', 'skipped', 'blocked', 'paused', 'error']),
  syncedAt: z.string().nullable(),
  detail: z.string().nullable().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
  // Qué fuente arrastró a esta. Solo viaja con status 'blocked'.
  blockedBy: z.string().optional(),
  invalidates: z.array(z.string()).optional(),
});
export type SyncResult = z.infer<typeof syncResultSchema>;

const syncStateSchema = z.object({
  now: z.string(),
  running: z.boolean(),
  hold: z.string().nullable(),
  // El techo global de frescura: nada scrapeado se queda más viejo que esto.
  // `ms: 0` significa que cada fuente conserva su propia frescura natural.
  interval: z
    .object({ ms: z.number(), defaultMs: z.number(), minMs: z.number(), maxMs: z.number() })
    .default({ ms: 3_600_000, defaultMs: 3_600_000, minMs: 900_000, maxMs: 86_400_000 }),
  sources: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      dependsOn: z.array(z.string()),
      ttlMs: z.number(),
      naturalTtlMs: z.number().default(0),
      needsPortal: z.boolean(),
      syncedAt: z.string().nullable(),
      ageMs: z.number().nullable(),
      expired: z.boolean(),
      relevant: z.boolean(),
      lastRunAt: z.string().nullable(),
      lastSuccessAt: z.string().nullable(),
      lastStatus: z.string().nullable(),
      error: z.string().nullable(),
      // El backend ya los calculaba y el esquema los tiraba: sin ellos la UI no
      // puede decir "reintenta en 12 min" y un error se lee como dato viejo.
      retryAt: z.string().nullable().default(null),
      cooling: z.boolean().default(false),
    })
  ),
});
export type SyncState = z.infer<typeof syncStateSchema>;

// ── Calendario académico oficial (P3) ───────────────────────────────────────
// Fechas públicas de PUCMM, cacheadas en SQLite. No es PeopleSoft y no lleva
// datos personales: es lo mismo que ve cualquiera en la web de la universidad.

const calendarEventSchema = z.object({
  id: z.string(),
  title: z.string(),
  startsOn: z.string(),
  endsOn: z.string(),
  url: z.string().nullable(),
  sourceUrl: z.string(),
});

const academicCalendarSchema = z.object({
  events: z.array(calendarEventSchema),
  // El mismo calendario partido contra hoy. `events` sigue siendo solo lo que
  // viene, para lo que ya lo consume; `timeline` es lo que permite ubicarse:
  // esto pasó, esto está pasando, esto viene.
  timeline: z
    .object({
      today: z.string(),
      past: z.array(calendarEventSchema),
      current: z.array(calendarEventSchema),
      future: z.array(calendarEventSchema),
    })
    .default({ today: '', past: [], current: [], future: [] }),
  total: z.number(),
  syncedAt: z.string().nullable(),
});
export type AcademicCalendar = z.infer<typeof academicCalendarSchema>;

export async function fetchAcademicCalendar(limit = 5, past = 3): Promise<AcademicCalendar> {
  return academicCalendarSchema.parse(await getJSON(`/api/academic-calendar?limit=${limit}&pasados=${past}`));
}

// ── Ritmo de cupo (feature nueva) ───────────────────────────────────────────
// La serie que mikampus viene guardando desde el primer día. El portal te dice
// cuántos asientos hay ahora; esto te dice cuántos había hace dos horas.

const seatTrendSchema = z.object({
  term: z.string().nullable(),
  trends: z.record(
    z.string(),
    z.object({
      samples: z.number(),
      change: z.number().nullable(),
      perHour: z.number().nullable(),
      direction: z.enum(['filling', 'opening', 'stable', 'unknown']),
      windowHours: z.number(),
      closedAt: z.string().nullable(),
      reopenedAt: z.string().nullable(),
      summary: z.string().nullable(),
      latestAt: z.string().nullable(),
      seatsOpen: z.number().nullable(),
    })
  ),
});
export type SeatTrends = z.infer<typeof seatTrendSchema>;

export async function fetchSeatTrends(term: string, classNbrs: string[]): Promise<SeatTrends> {
  if (!term || classNbrs.length === 0) return { term: term || null, trends: {} };
  const qs = new URLSearchParams({ term, classNbrs: classNbrs.join(',') });
  return seatTrendSchema.parse(await getJSON(`/api/seat-trend?${qs}`));
}

// ── Recordatorio antes de clase (feature nueva) ─────────────────────────────

const classRemindersSchema = z.object({
  enabled: z.boolean(),
  leadMinutes: z.number(),
  next: z
    .object({
      title: z.string(),
      room: z.string().nullable(),
      start: z.string(),
      minutesAway: z.number(),
      willNotify: z.boolean(),
    })
    .nullable(),
});
export type ClassReminders = z.infer<typeof classRemindersSchema>;

export async function fetchClassReminders(): Promise<ClassReminders> {
  return classRemindersSchema.parse(await getJSON('/api/class-reminders'));
}

export async function setClassReminders(input: { enabled?: boolean; leadMinutes?: number }): Promise<ClassReminders> {
  return classRemindersSchema.parse(await send('/api/class-reminders', 'PATCH', input));
}

export async function fetchSyncState(): Promise<SyncState> {
  return syncStateSchema.parse(await getJSON('/api/sync'));
}

// Cada cuánto se considera vieja la información traída de PeopleSoft. No sale
// al portal: mueve la línea a partir de la cual el próximo tick del agente sí
// lo hará. `0` deja a cada fuente con su frescura natural.
export async function setSyncInterval(intervalMs: number): Promise<SyncState> {
  const data = await send('/api/sync', 'PATCH', { intervalMs });
  return syncStateSchema.parse((data as { state: unknown }).state);
}

/**
 * `force` incluye las fuentes todavía vigentes. No evade consentimiento ni
 * prioridad: una inscripción en curso sigue mandando sobre el portal.
 */
export async function runSync(input: { force?: boolean; keys?: string[] } = {}) {
  return z
    .object({ results: z.array(syncResultSchema), state: syncStateSchema })
    .parse(await send('/api/sync', 'POST', input));
}


// ── Mesa de inscripción ─────────────────────────────────────────────────────
// Una sola llamada trae lo inscrito, lo pendiente que se oferta, la selección,
// la fase del ciclo y la antigüedad del cupo. Las tres mutaciones devuelven la
// mesa entera y no un fragmento: así la pantalla nunca queda con la selección
// nueva y los totales viejos.

// `planId` es el plan que la etapa de grupos está armando. Sin él el backend
// cae en el plan del ciclo, que es lo que la mesa usaba cuando era una pantalla
// aparte: la hoja para secretaría tiene que mostrar lo que elegiste, no otra
// selección paralela.
export async function fetchMesa(term?: string, planId?: number | null): Promise<MesaResponse> {
  const params = new URLSearchParams();
  if (term) params.set('term', term);
  if (planId != null) params.set('plan', String(planId));
  const query = params.toString();
  return mesaResponseSchema.parse(await getJSON(`/api/mesa${query ? `?${query}` : ''}`));
}

export async function setMesaSelection(input: {
  term: string;
  courseId: number;
  sectionId: number | null;
  relatedSectionId?: number | null;
}): Promise<MesaResponse> {
  return mesaResponseSchema.parse(await send('/api/mesa/seleccion', 'PUT', input));
}

export async function clearMesaSelection(input: { term: string; courseId: number }): Promise<MesaResponse> {
  const query = `?term=${encodeURIComponent(input.term)}`;
  return mesaResponseSchema.parse(await send(`/api/mesa/seleccion/${input.courseId}${query}`, 'DELETE'));
}

export async function solveMesa(input: {
  term: string;
  courseIds?: number[];
  constraints?: Partial<ScheduleConstraintsInput>;
}): Promise<MesaSolveResponse> {
  return mesaSolveResponseSchema.parse(await send('/api/mesa/armar', 'POST', input));
}

// ── Fase del ciclo ──────────────────────────────────────────────────────────
// El único lugar desde el que la app gatea capacidades. Que venga resuelto del
// backend es el punto: si cada pantalla comparara fechas por su cuenta, en dos
// semanas habría tres reglas distintas.
export async function fetchTermPhase(term?: string): Promise<TermPhaseResponse> {
  const query = term ? `?term=${encodeURIComponent(term)}` : '';
  return termPhaseResponseSchema.parse(await getJSON(`/api/term-phase${query}`));
}

export async function fetchTermEvents(term?: string): Promise<TermEventsResponse> {
  const query = term ? `?term=${encodeURIComponent(term)}` : '';
  return termEventsResponseSchema.parse(await getJSON(`/api/term-events${query}`));
}

// Reemplaza el calendario cargado a mano de un ciclo: borrar una fecha es no
// mandarla. Devuelve la fase ya recalculada para que la pantalla no tenga que
// pedirla aparte y quedar un instante con la fecha nueva y la etapa vieja.
export async function saveTermEvents(term: string, events: TermEventInput[]): Promise<TermPhaseResponse> {
  return termPhaseResponseSchema.parse(await send('/api/term-events', 'PUT', { term, events }));
}
