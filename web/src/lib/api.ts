import {
  appStateSchema,
  cartResponseSchema,
  catalogResponseSchema,
  planDetailSchema,
  planSummarySchema,
  planToCartResultSchema,
  scheduleResponseSchema,
  termInfoSchema,
  termContextSchema,
  gradesResponseSchema,
  pensumResponseSchema,
  holdsResponseSchema,
  accountInfoSchema,
  type AccountInfo,
  type AppState,
  type CartResponse,
  type CatalogResponse,
  type PlanDetail,
  type PlanSummary,
  type PlanToCartResult,
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

// El informe de avance lo genera el portal al vuelo: es la operación más lenta
// de la app (~30s).
export async function syncPensum(): Promise<{ ok: boolean; courses: number }> {
  return z.object({ ok: z.boolean(), courses: z.number() }).parse(await send('/api/pensum/sync', 'POST'));
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
