import {
  appStateSchema,
  cartRowSchema,
  catalogResponseSchema,
  type AppState,
  type CartRow,
  type CatalogResponse,
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
export function addToCart(input: { term: string; career: string; courseNumber: string; classNbr: string }) {
  return send('/api/search/add', 'POST', input) as Promise<{ ok?: boolean; alreadyInCart?: boolean }>;
}
