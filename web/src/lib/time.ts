// Las fechas llegan del backend en dos formatos y hay que distinguirlos:
//
//   - SQLite (datetime('now') → "2026-07-16 12:00:00"): es UTC, pero sin la Z
//     que lo diga. new Date() lo leería como hora LOCAL y el dato saldría
//     corrido las horas del huso.
//   - ISO de Node (new Date().toISOString() → "2026-07-16T12:00:00.000Z"): ya
//     trae su marca de huso.
//
// Pegarle una "Z" a todo rompe el segundo ("…ZZ" es Invalid Date) y no pegársela
// a nada rompe el primero. Por eso la regla vive en un solo lugar.
export function parseServerDate(raw: string): Date {
  const hasZone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(raw.trim());
  return new Date(hasZone ? raw : raw.replace(' ', 'T') + 'Z');
}

// "hace 2 h" — la antigüedad de un dato cacheado (principio #6: mostrar el dato
// con su antigüedad en vez de fingir que es en vivo).
export function ago(raw: string): string {
  const secs = Math.max(0, (Date.now() - parseServerDate(raw).getTime()) / 1000);
  if (secs < 60) return 'hace instantes';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `hace ${hrs} h`;
  return `hace ${Math.floor(hrs / 24)} d`;
}
