import type { ScheduleCourse } from '../../../src/shared/schemas.ts';
import { toMinutes, type DayCode } from '../../../src/shared/meetings.ts';

// Lógica de posicionamiento del WeeklyGrid, aparte del render: son funciones
// puras sobre datos, y así se pueden verificar sin montar React.

export type Block = {
  id: string;
  code: string;
  title: string;
  classNbr: string;
  section: string | null;
  component: string | null;
  room: string | null;
  instructor: string | null;
  day: DayCode;
  start: string;
  end: string;
};

// Aplana materias → secciones → reuniones → un bloque por día. Una sección que
// se reúne "MoWe 10:00-13:00" son dos bloques, uno en cada columna.
export function toBlocks(courses: ScheduleCourse[]): Block[] {
  const blocks: Block[] = [];
  for (const course of courses) {
    for (const section of course.sections) {
      for (const [mi, meeting] of section.meetings.entries()) {
        if (!meeting.start || !meeting.end) continue; // clases sin horario (TBA)
        for (const day of meeting.days) {
          blocks.push({
            id: `${section.id}-${mi}-${day}`,
            code: course.code,
            title: course.title,
            classNbr: section.classNbr,
            section: section.section,
            component: section.component,
            room: meeting.room,
            instructor: section.instructor,
            day: day as DayCode,
            start: meeting.start,
            end: meeting.end,
          });
        }
      }
    }
  }
  return blocks;
}

export type PlacedBlock = Block & {
  lane: number;
  lanes: number;
  conflictsWith: string[]; // títulos contra los que choca
};

const overlaps = (a: Block, b: Block) =>
  toMinutes(a.start) < toMinutes(b.end) && toMinutes(b.start) < toMinutes(a.end);

// Coloca los bloques de UN día en carriles. Dos clases a la misma hora no
// pueden taparse: se reparten el ancho de la columna y quedan las dos visibles.
// Greedy sobre bloques ordenados por hora: cada uno cae en el primer carril
// libre. El número de carriles se calcula por grupo de solapamiento, no para
// todo el día, para que un choque a las 8am no adelgace un bloque de las 6pm.
export function layoutDay(dayBlocks: Block[]): PlacedBlock[] {
  const sorted = [...dayBlocks].sort(
    (a, b) => toMinutes(a.start) - toMinutes(b.start) || toMinutes(a.end) - toMinutes(b.end)
  );

  const lane = new Map<string, number>();
  const laneEnds: number[] = [];
  for (const block of sorted) {
    let assigned = laneEnds.findIndex((end) => end <= toMinutes(block.start));
    if (assigned === -1) assigned = laneEnds.length;
    laneEnds[assigned] = toMinutes(block.end);
    lane.set(block.id, assigned);
  }

  // Un grupo de solapamiento es una cadena de bloques que se tocan entre sí
  // (directa o indirectamente). Todos comparten el mismo número de carriles.
  const groupOf = new Map<string, number>();
  let groupId = 0;
  let groupEnd = -1;
  for (const block of sorted) {
    if (toMinutes(block.start) >= groupEnd) groupId++;
    groupEnd = Math.max(groupEnd, toMinutes(block.end));
    groupOf.set(block.id, groupId);
  }

  const lanesPerGroup = new Map<number, number>();
  for (const block of sorted) {
    const g = groupOf.get(block.id)!;
    lanesPerGroup.set(g, Math.max(lanesPerGroup.get(g) ?? 1, (lane.get(block.id) ?? 0) + 1));
  }

  return sorted.map((block) => ({
    ...block,
    lane: lane.get(block.id)!,
    lanes: lanesPerGroup.get(groupOf.get(block.id)!)!,
    conflictsWith: sorted
      .filter((other) => other.id !== block.id && overlaps(block, other))
      .map((other) => other.title),
  }));
}

// Minutos → línea de grid. Las filas del grid arrancan en 1 y la primera la
// ocupa la cabecera de días, de ahí el +2.
export function toGridLine(hhmm: string, startHour: number, slotMinutes: number): number {
  return Math.round((toMinutes(hhmm) - startHour * 60) / slotMinutes) + 2;
}
