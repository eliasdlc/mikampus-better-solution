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

// Todas las respuestas del backend se validan contra los esquemas Zod
// compartidos: si un scraper devolvió basura, el error aparece acá con nombre,
// no como un render roto tres componentes más abajo.
async function getJSON(url: string): Promise<unknown> {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data;
}

async function send(url: string, method: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data;
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
// el feed SSE. La UI no se bloquea esperándolo. `term` (STRM) fija qué ciclo
// sincronizar — el que muestra el switcher; sin él, el server toma el default
// del portal (el arranque, cuando aún no se conoce el STRM del ciclo actual).
export async function syncMySchedule(term?: string): Promise<ScheduleResponse> {
  return scheduleResponseSchema.parse(await send('/api/my-schedule/sync', 'POST', term ? { term } : undefined));
}

export async function dropScheduleCourse(input: {
  term: string;
  courseCode: string;
  classNbr?: string | null;
  confirmCode: string;
}): Promise<DropResult> {
  return dropResultSchema.parse(await send('/api/my-schedule/drop', 'POST', input));
}

export function scheduleAt(atISO: string) {
  return send('/api/schedule', 'POST', { atISO });
}
export function cancelSchedule() {
  return send('/api/schedule', 'DELETE');
}
export function setWatcher(enabled: boolean, intervalMs?: number) {
  return send('/api/watch', 'POST', { enabled, intervalMs });
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
