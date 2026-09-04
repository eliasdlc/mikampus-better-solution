// Qué es un grupo y qué es una práctica, decidido en un solo lugar.
//
// Por qué existe: la app se contradecía consigo misma. La mesa y el solver del
// servidor separaban las prácticas de las teóricas; el planner, el builder, el
// buscador y la ficha de materia listaban `course.sections` crudo, así que
// ofrecían las prácticas como si fueran grupos alternativos de la misma
// materia. En un catálogo real eso es casi un tercio de las filas: elegir "el
// grupo" podía terminar guardando un laboratorio como si fuera la clase.
//
// La unidad de elección de la app es la teórica MÁS su práctica. Media materia
// no es un estado válido porque el portal no lo acepta.

// El componente de PeopleSoft que identifica una práctica o laboratorio. Vive
// acá y no repetido en seis archivos para que agregar otro componente (un
// seminario, una tutoría) sea una línea y no una cacería.
export const PRACTICE_COMPONENT = 'PRA';

type WithComponent = { component: string | null };

export function isPractice<T extends WithComponent>(section: T): boolean {
  return section.component === PRACTICE_COMPONENT;
}

/**
 * Los grupos entre los que se elige. Todo lo que no es práctica: una materia
 * sin laboratorio devuelve sus secciones tal cual.
 */
export function lectureSections<T extends WithComponent>(sections: readonly T[]): T[] {
  return sections.filter((section) => !isPractice(section));
}

/**
 * Las prácticas que acompañan a una teórica.
 *
 * Se acotan al campus de la teórica cuando ambos se conocen: una práctica en
 * otra ciudad no es una opción real, y ofrecerla es ofrecer un par que el
 * portal va a rechazar. Cuando el campus no se conoce no se filtra, porque
 * descartar por un dato ausente sería esconder opciones válidas.
 *
 * Qué práctica corresponde a qué teórica solo lo confirma el portal en su paso
 * Select. Esta función acota, no adivina.
 */
export function practiceSections<T extends WithComponent & { campus?: string | null }>(
  sections: readonly T[],
  lecture: { campus?: string | null } | null
): T[] {
  const practices = sections.filter(isPractice);
  const campus = lecture?.campus ?? null;
  if (campus == null) return practices;
  return practices.filter((section) => section.campus == null || section.campus === campus);
}

export function hasPractice<T extends WithComponent>(sections: readonly T[]): boolean {
  return sections.some(isPractice);
}

// ── Frescura del cupo ───────────────────────────────────────────────────────
// El portal publica un ícono, no un número de asientos en vivo. Lo único que
// sostiene "abierta" o "cerrada" es que la observación sea reciente; con un
// dato de hace tres días, afirmar el estado es inventar.
//
// La mesa ya aplicaba esta regla y la etapa de grupos no, así que la misma
// sección se leía "Abierta" en la pantalla donde se decide y "sin dato
// reciente" en la otra. El número vive acá para que no vuelva a haber dos.
export const SEAT_FRESH_HOURS = 24;

export function seatAgeHours(seatsUpdatedAt: string | null, now: Date = new Date()): number | null {
  if (!seatsUpdatedAt) return null;
  const stamp = seatsUpdatedAt.includes('T') ? seatsUpdatedAt : `${seatsUpdatedAt.replace(' ', 'T')}Z`;
  const ms = new Date(stamp).getTime();
  if (Number.isNaN(ms)) return null;
  return (now.getTime() - ms) / 3_600_000;
}

export function seatsAreFresh(seatsUpdatedAt: string | null, now: Date = new Date()): boolean {
  const hours = seatAgeHours(seatsUpdatedAt, now);
  return hours != null && hours <= SEAT_FRESH_HOURS;
}
