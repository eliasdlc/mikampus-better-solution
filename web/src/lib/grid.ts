import type { Meeting, ScheduleCourse } from '../../../src/shared/schemas.ts';
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
  // Preview del builder: el bloque se dibuja semitransparente y punteado
  // (hover sobre una sección no elegida) y no cuenta como choque real.
  ghost?: boolean;
};

// Bloques de UNA sección suelta (planner, builder, carrito): las pantallas
// nuevas componen su grid desde pares materia+sección, no desde el horario
// inscrito completo como toBlocks.
export function sectionToBlocks(
  course: { code: string; title: string },
  section: {
    classNbr: string;
    section: string | null;
    component: string | null;
    instructor: string | null;
    meetings: Meeting[];
  },
  { ghost = false }: { ghost?: boolean } = {}
): Block[] {
  const blocks: Block[] = [];
  for (const [mi, meeting] of section.meetings.entries()) {
    if (!meeting.start || !meeting.end) continue; // TBA no se puede dibujar
    for (const day of meeting.days) {
      blocks.push({
        id: `${ghost ? 'ghost-' : ''}${section.classNbr}-${mi}-${day}`,
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
        ghost,
      });
    }
  }
  return blocks;
}

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

// ¿Hay algún choque en el conjunto? El detalle de contra-quién choca cada bloque
// lo calcula layoutDay (y lo pinta el WeeklyGrid); esto responde solo el sí/no
// global —agrupando por día e ignorando fantasmas— para quien necesita la señal
// sin colocar carriles. conflictsWith solo existe en PlacedBlock, no en Block.
export function hasCollisions(blocks: Block[]): boolean {
  const byDay = new Map<DayCode, Block[]>();
  for (const block of blocks) {
    if (block.ghost) continue;
    const dayBlocks = byDay.get(block.day) ?? [];
    dayBlocks.push(block);
    byDay.set(block.day, dayBlocks);
  }
  for (const dayBlocks of byDay.values()) {
    for (let i = 0; i < dayBlocks.length; i++) {
      for (let j = i + 1; j < dayBlocks.length; j++) {
        if (overlaps(dayBlocks[i], dayBlocks[j])) return true;
      }
    }
  }
  return false;
}

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
    // Un fantasma no genera choques reales: es un preview, no una elección.
    conflictsWith: sorted
      .filter((other) => other.id !== block.id && !other.ghost && !block.ghost && overlaps(block, other))
      .map((other) => other.title),
  }));
}

// Minutos → línea de grid. Las filas del grid arrancan en 1 y la primera la
// ocupa la cabecera de días, de ahí el +2.
export function toGridLine(hhmm: string, startHour: number, slotMinutes: number): number {
  return Math.round((toMinutes(hhmm) - startHour * 60) / slotMinutes) + 2;
}

// ── Ventana horaria ────────────────────────────────────────────────────────

// El rango 7:00 a 22:00 estaba fijo, así que la grilla siempre dibujaba 15
// horas incluso cuando el horario real ocupaba cuatro, y la fila de las 7 no se
// usa nunca: en las 1319 reuniones del catálogo la más temprana empieza a las
// 08:00. Peor, un bloque fuera del rango simplemente no se dibujaba.
//
// La ventana se deriva de lo que hay: la hora entera anterior al primer bloque
// y la posterior al último, con un mínimo de horas para que un horario de una
// sola clase no quede como una tira. Sin bloques cae a una franja lectiva
// razonable, que es lo único que se puede hacer sin inventar.
export const FALLBACK_WINDOW = { startHour: 8, endHour: 18 } as const;
export const MIN_WINDOW_HOURS = 6;

export function timeWindow(
  blocks: Block[],
  { minHours = MIN_WINDOW_HOURS }: { minHours?: number } = {}
): { startHour: number; endHour: number } {
  const times = blocks.flatMap((block) => [toMinutes(block.start), toMinutes(block.end)]);
  if (times.length === 0) return { ...FALLBACK_WINDOW };

  let startHour = Math.floor(Math.min(...times) / 60);
  // Un bloque que termina en punto no necesita la hora siguiente entera.
  let endHour = Math.ceil(Math.max(...times) / 60);

  // Crecer hacia abajo primero y hacia arriba después: la mañana temprano se
  // usa menos que la noche, así que el relleno cae donde estorba menos.
  while (endHour - startHour < minHours) {
    if (endHour < 22) endHour += 1;
    else if (startHour > 6) startHour -= 1;
    else break;
  }

  return { startHour, endHour };
}

// ── Color por conjunto visible ─────────────────────────────────────────────

// El color global por hash reparte 907 materias en 14 tonos, así que en una
// pantalla con cuatro ICC es normal que dos compartan hue exacto: ICC-104,
// ICC-331, ICC-342 e ICC-371 lo hacen hoy. Acá el reparto es sobre lo que se
// ve: N materias en pantalla, N tonos separados lo más posible.
//
// El costo, dicho: una materia cambia de tono al cambiar el conjunto. Por eso
// el código va SIEMPRE escrito en el bloque, y el color no es nunca la única
// forma de distinguir una materia.
// Hue aproximado del acento en OKLCH. Los tonos de materia se rotan para
// quedar lo más lejos posible de él: si una materia cae en el mismo tono que el
// acento, el color deja de distinguir "esto es una materia" de "esto es una
// acción", que es lo único que el acento tiene permitido significar.
const HUE_ACENTO = 264;

export function paletteFor(blocks: Block[]): Map<string, number> {
  const codes = [...new Set(blocks.map((block) => block.code))].sort();
  const step = 360 / Math.max(1, codes.length);
  // Media vuelta de paso desde el acento deja el conjunto centrado en el hueco
  // más lejano: con tres materias son 120 grados entre sí y 60 al acento.
  const offset = (HUE_ACENTO + step / 2) % 360;
  return new Map(codes.map((code, i) => [code, (offset + i * step) % 360]));
}

// ── Bandas de la grilla ────────────────────────────────────────────────────

// La ventana dinámica sola no alcanza. Un horario que va de 10:00 a 21:00 y
// ocupa seis horas de clase sigue costando once filas, y cinco de ellas son un
// hueco: la tarde libre. Plegar las bandas que NINGÚN día usa es lo que baja la
// grilla a la mitad.
//
// La tira plegada dice cuántas horas se comió y se despliega, porque un hueco
// de cinco horas es información sobre tu semana, no ruido.
export type Band =
  | { kind: 'hora'; hour: number }
  | { kind: 'plegada'; fromHour: number; toHour: number; hours: number };

// Cuántas horas vacías seguidas hacen falta para que plegarlas gane algo.
// Con dos, plegar ahorra una fila y agrega una tira: no vale la pena.
export const MIN_HORAS_PLEGABLES = 3;

function horaOcupada(blocks: Block[], hour: number): boolean {
  const desde = hour * 60;
  const hasta = desde + 60;
  return blocks.some((block) => toMinutes(block.start) < hasta && desde < toMinutes(block.end));
}

export function foldBands(
  blocks: Block[],
  { startHour, endHour, minRun = MIN_HORAS_PLEGABLES }: { startHour: number; endHour: number; minRun?: number }
): Band[] {
  const bands: Band[] = [];
  let vacias: number[] = [];

  const cerrarRacha = () => {
    if (vacias.length >= minRun) {
      bands.push({ kind: 'plegada', fromHour: vacias[0], toHour: vacias.at(-1)! + 1, hours: vacias.length });
    } else {
      for (const hour of vacias) bands.push({ kind: 'hora', hour });
    }
    vacias = [];
  };

  for (let hour = startHour; hour < endHour; hour++) {
    if (horaOcupada(blocks, hour)) {
      cerrarRacha();
      bands.push({ kind: 'hora', hour });
    } else {
      vacias.push(hour);
    }
  }
  cerrarRacha();
  return bands;
}

// Una banda de hora son dos filas de media hora; una plegada es una sola fila.
// Las 1319 reuniones del catálogo empiezan y terminan en hora en punto y duran
// 60, 120, 180, 240 o 360 minutos: no existe el bloque de 45, así que los slots
// de 15 eran sesenta filas para representar quince posiciones.
export const FILAS_POR_HORA = 2;

export function bandRows(bands: Band[]): number {
  return bands.reduce((n, band) => n + (band.kind === 'hora' ? FILAS_POR_HORA : 1), 0);
}

// De una hora a su línea de grid. La fila 1 es la cabecera de días, así que la
// primera banda arranca en la 2. Una hora que cayó dentro de una tira plegada
// se ancla al borde de la tira: no tiene fila propia.
export function bandLine(bands: Band[], hhmm: string): number {
  const minutos = toMinutes(hhmm);
  let linea = 2;
  for (const band of bands) {
    if (band.kind === 'plegada') {
      if (minutos < band.toHour * 60) return linea;
      linea += 1;
      continue;
    }
    const desde = band.hour * 60;
    if (minutos < desde) return linea;
    if (minutos < desde + 60) return linea + Math.round((minutos - desde) / 30);
    linea += FILAS_POR_HORA;
  }
  return linea;
}

// Los días que hay que dibujar: los que tienen algo, en el orden de la semana.
// Sale de los bloques y no de una lista fija, así que un bloque en domingo deja
// de descartarse en silencio. Con el horario real quedan dos columnas y a 393px
// son anchas de verdad.
export function visibleDays(blocks: Block[], { all = false }: { all?: boolean } = {}): DayCode[] {
  const orden: DayCode[] = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  if (all) return orden.slice(0, 6);
  const usados = new Set(blocks.map((block) => block.day));
  const conClase = orden.filter((day) => usados.has(day));
  // Sin un solo bloque no hay nada que deducir: se muestra la semana laboral.
  return conClase.length > 0 ? conClase : orden.slice(0, 5);
}
