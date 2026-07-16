import { DAY_LABELS, WEEK_DAYS, type DayCode } from '../../../src/shared/meetings.ts';
import { courseColor } from '../lib/color.ts';
import { layoutDay, toGridLine, type Block, type PlacedBlock } from '../lib/grid.ts';

// El corazón visual de la app (plan §2): CSS Grid propio en vez de una librería
// de calendario. El dominio es fijo — Lun–Sáb, 7:00–22:00, slots de 15min — así
// que son 60 filas y control total del color, los choques y el responsive, a
// cambio de ~200 líneas y 0KB de dependencias.
//
// Todo se coloca como item del mismo grid (nada de posicionamiento absoluto):
// la fila sale de la hora y la columna del día. Los bloques que chocan comparten
// celda y se reparten el ancho con margin/width en %.
const START_HOUR = 7;
const END_HOUR = 22;
const SLOT_MINUTES = 15;
// Ancho de la canaleta de horas. Se usa en dos lugares que tienen que coincidir
// sí o sí: el ancho de la columna y el scroll-padding que la compensa.
const GUTTER = '3.25rem';
const SLOTS = ((END_HOUR - START_HOUR) * 60) / SLOT_MINUTES;
const HOURS = Array.from({ length: END_HOUR - START_HOUR }, (_, i) => START_HOUR + i);

const hourRow = (i: number) => `${i * 4 + 2} / span 4`;

function BlockCard({ block, column, animate }: { block: PlacedBlock; column: number; animate: boolean }) {
  const color = courseColor(block.code);
  const clash = block.conflictsWith.length > 0;

  return (
    <div
      className={`z-10 m-px overflow-hidden rounded-[var(--radius)] px-1.5 py-1 text-[11px] leading-tight ${
        block.ghost ? 'opacity-45' : ''
      } ${animate && !block.ghost ? 'block-land' : ''}`}
      style={{
        gridColumn: column,
        gridRow: `${toGridLine(block.start, START_HOUR, SLOT_MINUTES)} / ${toGridLine(block.end, START_HOUR, SLOT_MINUTES)}`,
        // Carriles: dos clases a la misma hora se reparten la columna en vez
        // de taparse. Con una sola, esto es 0% / 100%.
        marginLeft: `${(block.lane * 100) / block.lanes}%`,
        width: `calc(${100 / block.lanes}% - 2px)`,
        // El color de la materia tiñe el bloque; la barra va a color pleno para
        // que el hue se lea aun en bloques cortos.
        background: `color-mix(in oklch, ${color} 22%, var(--surface))`,
        borderLeft: `3px solid ${color}`,
        // El fantasma (preview de hover en el builder) se distingue también
        // por forma, no solo por opacidad: borde punteado alrededor.
        border: block.ghost ? `1px dashed ${color}` : undefined,
        // Un choque se raya en rojo: se ve que algo está mal sin leer nada.
        backgroundImage: clash
          ? 'repeating-linear-gradient(45deg, transparent, transparent 5px, color-mix(in oklch, var(--closed) 30%, transparent) 5px, color-mix(in oklch, var(--closed) 30%, transparent) 10px)'
          : undefined,
        outline: clash ? '1px solid var(--closed)' : undefined,
      }}
      title={
        clash
          ? `${block.title} · ${block.start}–${block.end} — choca con ${block.conflictsWith.join(', ')}`
          : [block.title, `${block.start}–${block.end}`, block.room, block.instructor].filter(Boolean).join('\n')
      }
    >
      <div className="truncate font-medium">{block.title}</div>
      <div className="tabular truncate font-mono text-[10px] opacity-70">
        {block.start}–{block.end}
      </div>
      {block.room && <div className="truncate text-[10px] opacity-70">{block.room}</div>}
    </div>
  );
}

// `animate` prende el único momento orquestado de la app (plan §3): el bloque
// "aterrizando" al elegir una sección en planner/builder. La animación corre
// al montar; como la key de cada bloque incluye el classNbr, un swap de
// sección remonta el bloque y la repite. Off por defecto (horario, carrito).
export function WeeklyGrid({ blocks, animate = false }: { blocks: Block[]; animate?: boolean }) {
  const byDay = new Map<DayCode, Block[]>(WEEK_DAYS.map((d) => [d, []]));
  for (const block of blocks) byDay.get(block.day)?.push(block);

  // El sábado solo ocupa una columna si alguien tiene clases ahí.
  const days = WEEK_DAYS.filter((d, i) => i < 5 || (byDay.get(d)?.length ?? 0) > 0);

  return (
    <div className="border-line bg-surface overflow-hidden rounded-[var(--radius)] border">
      {/* En mobile cada día ocupa ~68vw y esto scrollea con snap (el "carrusel
          de días" del plan); en desktop las columnas entran juntas.
          scrollPaddingLeft compensa la canaleta sticky: sin esto, el snap alinea
          el día contra el borde del contenedor y la canaleta se lo come. */}
      <div className="snap-x snap-mandatory overflow-x-auto" style={{ scrollPaddingLeft: GUTTER }}>
        <div
          className="weekly-grid grid"
          style={{
            gridTemplateColumns: `${GUTTER} repeat(${days.length}, minmax(var(--day-min), 1fr))`,
            gridTemplateRows: `auto repeat(${SLOTS}, minmax(0.5rem, 1fr))`,
          }}
        >
          {/* Cabecera. La esquina y la canaleta quedan sticky a la izquierda
              para no perder la referencia horaria al scrollear los días.
              La esquina va por DEBAJO de las etiquetas de hora (z-10 < z-20):
              la primera, 07:00, sobresale hacia arriba de su fila y si no,
              la esquina la taparía. */}
          <div className="bg-surface border-line sticky left-0 z-10 border-b" style={{ gridColumn: 1, gridRow: 1 }} />
          {days.map((day, i) => (
            <div
              key={day}
              className="bg-surface border-line text-muted snap-start border-b border-l px-2 py-1.5 text-center text-xs font-medium"
              style={{ gridColumn: i + 2, gridRow: 1 }}
            >
              {DAY_LABELS[day]}
            </div>
          ))}

          {/* Canaleta de horas. */}
          {HOURS.map((h, i) => (
            <div
              key={h}
              className="bg-surface border-line/60 text-muted tabular sticky left-0 z-20 border-t pr-2 text-right font-mono text-[10px]"
              style={{ gridColumn: 1, gridRow: hourRow(i) }}
            >
              <span className="relative -top-1.5">{String(h).padStart(2, '0')}:00</span>
            </div>
          ))}

          {/* Hairlines de hora a lo ancho de los días (sin sombras: regla de
              composición del sistema de diseño). */}
          {HOURS.map((h, i) => (
            <div
              key={h}
              className="border-line/60 pointer-events-none border-t"
              style={{ gridColumn: `2 / span ${days.length}`, gridRow: hourRow(i) }}
              aria-hidden
            />
          ))}

          {/* Separadores de columna. */}
          {days.map((day, i) => (
            <div
              key={day}
              className="border-line pointer-events-none border-l"
              style={{ gridColumn: i + 2, gridRow: `2 / span ${SLOTS}` }}
              aria-hidden
            />
          ))}

          {days.flatMap((day, i) =>
            layoutDay(byDay.get(day) ?? []).map((block) => (
              <BlockCard key={block.id} block={block} column={i + 2} animate={animate} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
