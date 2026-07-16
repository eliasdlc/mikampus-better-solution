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

// Carrito real (endpoint existente /api/cart), tipado para la migración a React.
export const cartRowSchema = z.object({
  index: z.number().int(),
  classLabel: z.string(),
  status: z.string().nullable(),
});
export type CartRow = z.infer<typeof cartRowSchema>;

// Estado del scheduler + watcher (GET /api/state).
export const appStateSchema = z.object({
  schedule: z.object({ atISO: z.string() }).nullable(),
  watcher: z.object({ intervalMs: z.number() }).nullable(),
});
export type AppState = z.infer<typeof appStateSchema>;
