// Los plazos de baja POR CLASE, tal como PeopleSoft los publica.
//
// El recon del 2026-09-03 contra la pantalla real cerró una pregunta que
// llevaba abierta desde que se escribió el scraper: "Enrollment Deadlines" no
// publica las etapas del ciclo. Publica tres fechas de una clase concreta, y
// cada una dice qué le pasa a tu récord si la das de baja antes o después.
//
// Por eso esto NO alimenta term_events. Mapear "Drop with Penalty" (5 de
// septiembre) a retiro-parcial habría apagado el botón de dar de baja dos meses
// antes de la fecha institucional real (6 de noviembre): un control apagado por
// una fecha mal traducida es el peor resultado posible acá.
//
// Lo que estas fechas sí contestan, y el calendario institucional no puede,
// es "si la doy de baja HOY, ¿queda en mi récord?".

export const DROP_DEADLINE_IDS = ['delete-record', 'retain-record', 'with-penalty'] as const;
export type DropDeadlineId = (typeof DROP_DEADLINE_IDS)[number];

export type ClassDropDeadlines = {
  classNbr: string | null;
  session: string;
  // "Drop - Delete Record": hasta acá la baja borra la clase del récord.
  deleteBy: string | null;
  // "Drop - Retain Record": hasta acá queda con estado 'dropped'.
  retainBy: string | null;
  // "Drop with Penalty": desde acá la baja lleva penalidad.
  penaltyFrom: string | null;
};

type Regla = { id: DropDeadlineId; match: RegExp };

// El portal publica estas etiquetas en inglés aunque el resto de la interfaz
// esté en español. Se aceptan las dos por si cambia la configuración regional,
// y el texto se compara sin acentos y en minúsculas.
const REGLAS: readonly Regla[] = [
  { id: 'delete-record', match: /^drop *[-–] *delete record$|baja.*(borra|elimina).*(record|expediente)/ },
  { id: 'retain-record', match: /^drop *[-–] *retain record$|baja.*(mantiene|conserva).*(record|expediente)/ },
  { id: 'with-penalty', match: /^drop with penalty$|baja con (penalidad|recargo)/ },
];

export function normalizeLabel(label: string): string {
  return (label ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function mapDropDeadlineLabel(label: string): DropDeadlineId | null {
  const text = normalizeLabel(label);
  if (!text) return null;
  return REGLAS.find((regla) => regla.match.test(text))?.id ?? null;
}

/**
 * Resuelve si un conjunto de fechas numéricas es MM/DD o DD/MM.
 *
 * Se decide con el conjunto entero y no fecha por fecha, que es lo que permite
 * no adivinar: si en alguna el primer componente pasa de 12, solo puede ser el
 * día; si en alguna el segundo pasa de 12, solo puede ser el día. Cuando las
 * dos lecturas siguen siendo posibles en TODAS, se devuelve null y quien llama
 * las reporta como ilegibles en vez de elegir una.
 *
 * Con la pantalla real ("08/25/2026") el 25 resuelve el conjunto entero.
 */
export function resolveNumericDateOrder(values: readonly string[]): 'month-first' | 'day-first' | null {
  let monthFirst = false;
  let dayFirst = false;
  for (const value of values) {
    const m = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) dayFirst = true;
    if (b > 12 && a <= 12) monthFirst = true;
  }
  if (monthFirst && dayFirst) return null; // el portal se contradice: no se elige
  if (monthFirst) return 'month-first';
  if (dayFirst) return 'day-first';
  return null;
}

/** "08/25/2026" con el orden ya resuelto → "2026-08-25". */
export function numericDateToISO(raw: string, order: 'month-first' | 'day-first'): string | null {
  const m = (raw ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const month = Number(order === 'month-first' ? m[1] : m[2]);
  const day = Number(order === 'month-first' ? m[2] : m[1]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export type DropConsequence =
  | { level: 'delete'; until: string; message: string }
  | { level: 'retain'; until: string; message: string }
  | { level: 'penalty'; since: string; message: string }
  | { level: 'desconocida'; message: string };

/**
 * Qué le pasa a tu récord si das de baja esta clase hoy.
 *
 * `today` entra por parámetro: una consecuencia que depende del reloj del
 * sistema no se puede probar contra un día fijo.
 *
 * Los bordes son inclusivos porque el portal lo dice con todas las letras: "a
 * class dropped ON OR BEFORE this date will be...".
 */
export function dropConsequence(deadlines: ClassDropDeadlines, today: string): DropConsequence {
  if (deadlines.deleteBy && today <= deadlines.deleteBy) {
    return {
      level: 'delete',
      until: deadlines.deleteBy,
      message: 'Si la das de baja hoy, desaparece de tu récord como si nunca la hubieras tomado.',
    };
  }
  if (deadlines.retainBy && today <= deadlines.retainBy) {
    return {
      level: 'retain',
      until: deadlines.retainBy,
      message: 'Si la das de baja hoy, queda en tu récord con estado "dropped", sin penalidad.',
    };
  }
  if (deadlines.penaltyFrom && today >= deadlines.penaltyFrom) {
    return {
      level: 'penalty',
      since: deadlines.penaltyFrom,
      message: 'Darla de baja hoy lleva penalidad: el portal la registra como baja con recargo.',
    };
  }
  // Media tabla conocida no alcanza para afirmar una consecuencia, y afirmarla
  // igual sería exactamente lo que este módulo existe para no hacer.
  return {
    level: 'desconocida',
    message: 'El portal no publicó los plazos de baja de esta clase.',
  };
}
