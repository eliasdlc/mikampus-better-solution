import {
  appStateSchema,
  cartRowSchema,
  catalogResponseSchema,
  planDetailSchema,
  planSummarySchema,
  planToCartResultSchema,
  scheduleResponseSchema,
  termInfoSchema,
  type AppState,
  type CartRow,
  type CatalogResponse,
  type PlanDetail,
  type PlanSummary,
  type PlanToCartResult,
  type ScheduleResponse,
  type TermInfo,
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

export async function fetchCart(): Promise<CartRow[]> {
  const data = await getJSON('/api/cart');
  return z.object({ rows: z.array(cartRowSchema) }).parse(data).rows;
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
// el feed SSE. La UI no se bloquea esperándolo.
export async function syncMySchedule(): Promise<ScheduleResponse> {
  return scheduleResponseSchema.parse(await send('/api/my-schedule/sync', 'POST'));
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

export async function fetchTerms(): Promise<TermInfo[]> {
  const data = await getJSON('/api/terms');
  return z.object({ terms: z.array(termInfoSchema) }).parse(data).terms;
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
