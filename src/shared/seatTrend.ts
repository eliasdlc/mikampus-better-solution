// El ritmo de un cupo.
//
// mikampus lleva desde el primer día guardando un snapshot de cupo cada vez que
// el watcher o el catálogo miran una sección, y nunca leyó más de la última
// fila. Esa serie es lo único que la app tiene y micampus no: el portal te dice
// cuántos asientos quedan AHORA, y no puede decirte que hace dos horas había
// doce. Durante una inscripción esa diferencia es la decisión completa —entre
// pelear por una sección o cambiarse a otra— y hasta ahora estaba en la base de
// datos sin que nadie la mirara.
//
// Regla de honestidad, la misma de todo el producto: acá solo se reportan
// HECHOS OBSERVADOS. El ritmo es el que se midió, no una predicción de cuándo
// se va a llenar; una estimación así depende de cuánta gente tiene su cita a
// esa hora, que es justo lo que no sabemos.

export type SeatSnapshot = {
  status: string | null;
  seatsOpen: number | null;
  seatsCap: number | null;
  capturedAt: string;
};

export type SeatTrend = {
  /** Cuántas observaciones hay detrás. Con una sola no hay ritmo que medir. */
  samples: number;
  latest: SeatSnapshot | null;
  /** La observación más vieja dentro de la ventana mirada. */
  earliest: SeatSnapshot | null;
  /** Horas entre la primera y la última observación de la ventana. */
  windowHours: number;
  /** Asientos ganados (+) o perdidos (−) en la ventana. null si falta el dato. */
  change: number | null;
  /** Asientos perdidos por hora, observados. Negativo = se está llenando. */
  perHour: number | null;
  direction: 'filling' | 'opening' | 'stable' | 'unknown';
  /** Cuándo se observó por primera vez cerrada tras estar abierta. */
  closedAt: string | null;
  /** Cuándo se observó reabrir tras estar cerrada. */
  reopenedAt: string | null;
};

const EMPTY: SeatTrend = {
  samples: 0,
  latest: null,
  earliest: null,
  windowHours: 0,
  change: null,
  perHour: null,
  direction: 'unknown',
  closedAt: null,
  reopenedAt: null,
};

function hoursBetween(from: string, to: string): number {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Number.isFinite(ms) ? ms / 3_600_000 : 0;
}

function isOpen(snapshot: SeatSnapshot): boolean {
  if (snapshot.status) return snapshot.status === 'open';
  return (snapshot.seatsOpen ?? 0) > 0;
}

/**
 * El ritmo observado de una sección.
 *
 * @param snapshots en cualquier orden; se ordenan acá por `capturedAt`
 * @param windowHours cuánto hacia atrás mirar. Más allá, el dato es de otro
 *        momento de la inscripción y mezclarlo dice menos, no más.
 */
export function seatTrend(snapshots: SeatSnapshot[], { windowHours = 24, now = new Date() } = {}): SeatTrend {
  if (!snapshots.length) return EMPTY;

  const ordered = [...snapshots].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const cutoff = new Date(now.getTime() - windowHours * 3_600_000).toISOString();
  // Siempre se conserva la última observación aunque sea vieja: "el último dato
  // que tenemos es de hace tres días" es información, no ausencia de ella.
  const latest = ordered[ordered.length - 1];
  const window = ordered.filter((snapshot) => snapshot.capturedAt >= cutoff);

  if (window.length < 2) {
    return { ...EMPTY, samples: window.length || 1, latest, earliest: window[0] ?? latest };
  }

  const earliest = window[0];
  const elapsed = hoursBetween(earliest.capturedAt, latest.capturedAt);

  const change =
    earliest.seatsOpen == null || latest.seatsOpen == null ? null : latest.seatsOpen - earliest.seatsOpen;
  const perHour = change === null || elapsed <= 0 ? null : change / elapsed;

  // El umbral evita llamar "llenándose" a una sección que perdió un asiento en
  // ocho horas: eso es ruido, no una tendencia que deba cambiar tu decisión.
  let direction: SeatTrend['direction'] = 'unknown';
  if (change !== null) {
    if (change <= -1 && (perHour ?? 0) <= -0.25) direction = 'filling';
    else if (change >= 1) direction = 'opening';
    else direction = 'stable';
  }

  // Transiciones observadas. Se recorre la ventana buscando el ÚLTIMO cambio de
  // estado en cada sentido: importa el más reciente, no el primero del historial.
  let closedAt: string | null = null;
  let reopenedAt: string | null = null;
  for (let i = 1; i < window.length; i++) {
    const before = isOpen(window[i - 1]);
    const after = isOpen(window[i]);
    if (before && !after) closedAt = window[i].capturedAt;
    if (!before && after) reopenedAt = window[i].capturedAt;
  }

  return {
    samples: window.length,
    latest,
    earliest,
    windowHours: Math.round(elapsed * 10) / 10,
    change,
    perHour: perHour === null ? null : Math.round(perHour * 100) / 100,
    direction,
    closedAt,
    reopenedAt,
  };
}

/**
 * Una frase que se pueda leer de un vistazo, o null si no hay nada que decir.
 * Nunca predice: describe lo que se midió y en cuánto tiempo.
 */
export function describeTrend(trend: SeatTrend): string | null {
  if (trend.samples < 2 || trend.change === null) return null;

  const horas = trend.windowHours;
  const cuando = horas < 1.5 ? `en la última hora` : `en las últimas ${Math.round(horas)} h`;

  if (trend.direction === 'filling') {
    const perdidos = Math.abs(trend.change);
    return `perdió ${perdidos} cupo${perdidos === 1 ? '' : 's'} ${cuando}`;
  }
  if (trend.direction === 'opening') {
    return `abrió ${trend.change} cupo${trend.change === 1 ? '' : 's'} ${cuando}`;
  }
  return `sin cambios ${cuando}`;
}
