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
