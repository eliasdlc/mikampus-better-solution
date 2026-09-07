import { DAY_CODES, toMinutes, type DayCode } from './meetings.ts';

// "¿Qué tengo hoy y qué viene ahora?" — la pregunta que contesta el Dashboard
// (plan §5.1). Es aritmética pura sobre bloques y una fecha: vive acá, aparte
// del render, para poder verificarla sin montar React (scripts/test-agenda.mjs).
//
// Genérico sobre cualquier cosa que tenga día y horas: así sirve tanto para los
// bloques del horario inscrito como para los del carrito o un plan, sin que este
// módulo tenga que conocer el tipo Block del frontend.
export type TimedBlock = { day: DayCode; start: string; end: string };

// getDay() devuelve 0 para domingo; DAY_CODES arranca en lunes.
export function dayCodeOf(date: Date): DayCode {
  return DAY_CODES[(date.getDay() + 6) % 7];
}

export function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

// Lo de un día, en orden de reloj. Ordena por hora de inicio y desempata por la
// de fin, igual que layoutDay: dos vistas del mismo día no pueden discrepar en
// el orden.
export function agendaFor<T extends TimedBlock>(blocks: T[], date: Date): T[] {
  const day = dayCodeOf(date);
  return blocks
    .filter((b) => b.day === day)
    .sort((a, b) => toMinutes(a.start) - toMinutes(b.start) || toMinutes(a.end) - toMinutes(b.end));
}

export type NextClass<T> = {
  block: T;
  at: Date;
  // Ya empezó y todavía no termina. El Dashboard la muestra como "en curso" y
  // cuenta hacia el final, no hacia el inicio: faltar -20 minutos no es un dato.
  ongoing: boolean;
};

// La próxima clase mirando hacia adelante desde `now`, dando la vuelta a la
// semana si hace falta (un viernes por la noche, la próxima es el lunes).
// Una clase en curso gana: es la que estás teniendo.
//
// El horizonte es de 7 días y no infinito: los bloques son un patrón semanal,
// así que si no hay nada en una vuelta completa, no hay nada. Sin ese tope, un
// horario vacío buscaría para siempre.
export function nextClass<T extends TimedBlock>(blocks: T[], now: Date): NextClass<T> | null {
  const nowMinutes = minutesOfDay(now);

  for (let offset = 0; offset <= 7; offset++) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    for (const block of agendaFor(blocks, date)) {
      // Hoy, lo que ya terminó no cuenta. Del octavo día solo sirve lo que caiga
      // antes de esta hora: más tarde ya lo devolvió la vuelta anterior.
      if (offset === 0 && toMinutes(block.end) <= nowMinutes) continue;
      if (offset === 7 && toMinutes(block.start) >= nowMinutes) continue;

      const at = new Date(date);
      at.setHours(...(block.start.split(':').map(Number) as [number, number]), 0, 0);
      return { block, at, ongoing: offset === 0 && toMinutes(block.start) <= nowMinutes };
    }
  }
  return null;
}

// ── Una sola semana: clases y entregas ─────────────────────────────────────
//
// Las dos fuentes hablan de tiempos distintos y por eso no se pueden mezclar
// como si fueran lo mismo. Una clase es un BLOQUE: tiene principio y fin, se
// repite todas las semanas y ocupa espacio en la grilla. Una entrega es un
// INSTANTE: cae a una hora exacta de un día exacto, no se repite y no ocupa
// nada. Un modelo que las trate igual termina pintando una entrega como una
// clase de un minuto, o peor, obligando a elegir cuál de las dos se ve.
//
// Acá conviven ordenadas por reloj, cada una diciendo qué es. Quién las pinta
// decide cómo; esto solo garantiza que el orden del día sea uno solo.

export type Deadline = {
  /** Epoch en segundos, que es la unidad de la PVA. */
  at: number;
  id: string;
  title: string;
  courseLabel?: string | null;
  /** null cuando nunca se consultó el estado: no es lo mismo que "sin entregar". */
  submitted?: boolean | null;
  url?: string | null;
};

export type TimelineEntry<T> =
  | { kind: 'class'; at: number; endsAt: number; block: T }
  | { kind: 'deadline'; at: number; endsAt: null; deadline: Deadline };

function sameLocalDay(seconds: number, date: Date): boolean {
  const at = new Date(seconds * 1000);
  return (
    at.getFullYear() === date.getFullYear() && at.getMonth() === date.getMonth() && at.getDate() === date.getDate()
  );
}

/**
 * El día completo, en orden de reloj: las clases de ese día y las entregas que
 * vencen ese día, cada una en su minuto.
 *
 * El día de una entrega se resuelve en hora LOCAL y no en UTC. En Santo Domingo
 * (UTC-4) una entrega de las 11:59 pm es 03:59 UTC del día siguiente, así que
 * comparar fechas ISO la corre un día hacia adelante y aparecería en el día
 * equivocado, que es justo el día en que ya no se puede entregar.
 */
export function dayTimeline<T extends TimedBlock>(
  blocks: T[],
  deadlines: Deadline[],
  date: Date
): TimelineEntry<T>[] {
  const classes: TimelineEntry<T>[] = agendaFor(blocks, date).map((block) => ({
    kind: 'class',
    at: toMinutes(block.start),
    endsAt: toMinutes(block.end),
    block,
  }));
  const dues: TimelineEntry<T>[] = deadlines
    .filter((deadline) => sameLocalDay(deadline.at, date))
    .map((deadline) => {
      const at = new Date(deadline.at * 1000);
      return { kind: 'deadline', at: at.getHours() * 60 + at.getMinutes(), endsAt: null, deadline };
    });

  // Empate a la misma hora: primero la clase, que ocupa un rato, y después la
  // entrega, que es un punto. Al revés, la entrega quedaría escondida entre las
  // horas de una clase que arranca al mismo minuto.
  return [...classes, ...dues].sort((left, right) => left.at - right.at || (left.kind === 'class' ? -1 : 1));
}

/** Los días de una semana que tienen algo, con lo que tienen. */
export function weekTimeline<T extends TimedBlock>(
  blocks: T[],
  deadlines: Deadline[],
  from: Date,
  days = 7
): { date: Date; entries: TimelineEntry<T>[] }[] {
  const out: { date: Date; entries: TimelineEntry<T>[] }[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset);
    out.push({ date, entries: dayTimeline(blocks, deadlines, date) });
  }
  return out;
}

/**
 * Lo próximo que pasa, sea una clase o una entrega. El Dashboard pregunta "¿qué
 * sigue?" y la respuesta honesta puede ser cualquiera de las dos: decir "tu
 * próxima clase es el lunes" cuando hay una entrega esta noche es contestar otra
 * pregunta.
 */
export function nextThing<T extends TimedBlock>(
  blocks: T[],
  deadlines: Deadline[],
  now: Date
): { kind: 'class' | 'deadline'; at: Date; block?: T; deadline?: Deadline; ongoing: boolean } | null {
  const upcoming = deadlines
    .filter((deadline) => deadline.at * 1000 > now.getTime() && deadline.submitted !== true)
    .sort((left, right) => left.at - right.at)[0];
  const klass = nextClass(blocks, now);

  if (!upcoming) return klass ? { kind: 'class', at: klass.at, block: klass.block, ongoing: klass.ongoing } : null;
  const dueAt = new Date(upcoming.at * 1000);
  // Una clase en curso gana igual: es lo que estás teniendo ahora mismo.
  if (klass && (klass.ongoing || klass.at <= dueAt)) {
    return { kind: 'class', at: klass.at, block: klass.block, ongoing: klass.ongoing };
  }
  return { kind: 'deadline', at: dueAt, deadline: upcoming, ongoing: false };
}
