import {
  appStateSchema,
  cartResponseSchema,
  catalogResponseSchema,
  planDetailSchema,
  planSummarySchema,
  planToCartResultSchema,
  recommendationResponseSchema,
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
  type RecommendationResponse,
  type ScheduleResponse,
  type TermInfo,
  type TermContext,
  type GradesResponse,
  type PensumResponse,
  type HoldsResponse,
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
}) {
  return send('/api/watch', 'POST', input);
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
  relatedClassNbr?: string;
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

export async function addPlanItem(
  planId: number,
  input: { courseId: number; sectionId?: number | null; note?: string | null }
): Promise<PlanDetail> {
  return planDetailSchema.parse(await send(`/api/plans/${planId}/items`, 'POST', input));
}

export async function updatePlanItem(
  planId: number,
  itemId: number,
  patch: { sectionId?: number | null; note?: string | null; locked?: boolean }
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

// ── Recomendador (/planner, Fase 9) ─────────────────────────────────────────
export async function fetchRecommendation(term: string, maxCredits: number): Promise<RecommendationResponse> {
  const qs = new URLSearchParams({ term, maxCredits: String(maxCredits) });
  return recommendationResponseSchema.parse(await getJSON(`/api/recommendation?${qs}`));
}

export async function createRecommendedPlan(input: {
  term: string;
  maxCredits: number;
  name?: string;
}): Promise<PlanDetail> {
  return planDetailSchema.parse(await send('/api/recommendation/plan', 'POST', input));
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
  monitoringGap: z.object({ from: z.string(), to: z.string(), ms: z.number(), detail: z.string().nullable() }).nullable(),
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
  status: z.enum(['fresh', 'updated', 'skipped', 'paused', 'error']),
  syncedAt: z.string().nullable(),
  detail: z.string().nullable().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
  invalidates: z.array(z.string()).optional(),
});
export type SyncResult = z.infer<typeof syncResultSchema>;

const syncStateSchema = z.object({
  now: z.string(),
  running: z.boolean(),
  hold: z.string().nullable(),
  sources: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      dependsOn: z.array(z.string()),
      ttlMs: z.number(),
      needsPortal: z.boolean(),
      syncedAt: z.string().nullable(),
      ageMs: z.number().nullable(),
      expired: z.boolean(),
      relevant: z.boolean(),
      lastRunAt: z.string().nullable(),
      lastSuccessAt: z.string().nullable(),
      lastStatus: z.string().nullable(),
      error: z.string().nullable(),
    })
  ),
});
export type SyncState = z.infer<typeof syncStateSchema>;

// ── Calendario académico oficial (P3) ───────────────────────────────────────
// Fechas públicas de PUCMM, cacheadas en SQLite. No es PeopleSoft y no lleva
// datos personales: es lo mismo que ve cualquiera en la web de la universidad.

const academicCalendarSchema = z.object({
  events: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      startsOn: z.string(),
      endsOn: z.string(),
      url: z.string().nullable(),
      sourceUrl: z.string(),
    })
  ),
  total: z.number(),
  syncedAt: z.string().nullable(),
});
export type AcademicCalendar = z.infer<typeof academicCalendarSchema>;

export async function fetchAcademicCalendar(limit = 5): Promise<AcademicCalendar> {
  return academicCalendarSchema.parse(await getJSON(`/api/academic-calendar?limit=${limit}`));
}

export async function fetchSyncState(): Promise<SyncState> {
  return syncStateSchema.parse(await getJSON('/api/sync'));
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
