import { DAY_LABELS, WEEK_DAYS, type DayCode } from '../../../src/shared/meetings.ts';
import { hueColor } from '../lib/color.ts';
import { layoutDay, paletteFor, timeWindow, toGridLine, type Block, type PlacedBlock } from '../lib/grid.ts';

// El corazón visual de la app: CSS Grid propio en vez de una librería de
// calendario. Control total del color, los choques y el responsive a cambio de
// unas 250 líneas y 0KB de dependencias.
//
// Tres cosas que ya no son fijas, y por qué:
//
//   1. La VENTANA HORARIA se deriva de los bloques (timeWindow). Era 7:00 a
//      22:00 siempre: quince horas de grilla para mostrar cuatro, con la fila
//      de las 7 sin usar nunca (en las 1319 reuniones del catálogo la más
//      temprana empieza a las 08:00), y un bloque fuera del rango simplemente
//      no se dibujaba.
//   2. El COLOR se reparte sobre las materias visibles (paletteFor) en vez de
//      hashear 907 materias en 14 tonos, donde ICC-104, ICC-331, ICC-342 e
//      ICC-371 comparten hue exacto. El costo: una materia cambia de tono al
//      cambiar el conjunto, y por eso el código va siempre escrito.
//   3. En contenedores angostos la semana se dibuja como AGENDA por día. Seis
//      columnas en 393px dan 55px por día y truncan el título a nueve
//      caracteres. Lo decide una container query sobre el ancho DISPONIBLE, no
//      el de la ventana: la misma pieza dentro de un panel angosto en
//      escritorio tiene el mismo problema.
//
// Todo se coloca como item del mismo grid (nada de posicionamiento absoluto):
// la fila sale de la hora y la columna del día. Los bloques que chocan comparten
// celda y se reparten el ancho con margin/width en %.
const SLOT_MINUTES = 15;
// Ancho de la canaleta de horas. Se usa en dos lugares que tienen que coincidir
// sí o sí: el ancho de la columna y el scroll-padding que la compensa.
const GUTTER = '3.25rem';
// Cada hora ocupa cuatro slots de 15 minutos; el +2 salta la fila de cabecera.
const hourRow = (i: number) => `${i * 4 + 2} / span 4`;

function BlockCard({
  block,
  column,
  hue,
  animate,
  rowFor,
  onSelect,
}: {
  block: PlacedBlock;
  column: number;
  hue: number;
  animate: boolean;
  rowFor: (hhmm: string) => number;
  onSelect?: (block: PlacedBlock) => void;
}) {
  const color = hueColor(hue);
  const clash = block.conflictsWith.length > 0;

  return (
    <div
      className={`z-10 m-px overflow-hidden rounded-[var(--radius)] px-1.5 py-1 text-left text-[11px] leading-tight ${
        block.ghost ? 'opacity-45' : ''
      } ${animate && !block.ghost ? 'block-land' : ''} ${
        onSelect ? 'focus-visible:outline-accent cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-1' : ''
      }`}
      style={{
        gridColumn: column,
        gridRow: `${rowFor(block.start)} / ${rowFor(block.end)}`,
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
      // El title nativo se conserva como atajo con mouse, pero ya no es el
      // ÚNICO camino a esta información: cuando hay onSelect, el bloque es un
      // botón real y el detalle abre con Enter, con tap y con click (P4 §5).
      title={
        clash
          ? `${block.title} · ${block.start}–${block.end} — choca con ${block.conflictsWith.join(', ')}`
          : [block.title, `${block.start}–${block.end}`, block.room, block.instructor].filter(Boolean).join('\n')
      }
      {...(onSelect
        ? {
            role: 'button' as const,
            tabIndex: 0,
            'aria-label': `${block.title}, ${block.start} a ${block.end}, ${block.room ?? 'aula por definir'}, ${block.instructor ?? 'profesor no publicado'}`,
            onClick: () => onSelect(block),
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(block);
              }
            },
          }
        : {})}
    >
      <div className="truncate font-medium">{block.code}</div>
      <div className="truncate opacity-80">{block.title}</div>
      <div className="tabular truncate font-mono text-[10px] opacity-70">
        {block.start}–{block.end}
      </div>
      {block.room && <div className="truncate text-[10px] opacity-70">{block.room}</div>}
    </div>
  );
}

// La misma información por día, para cuando la grilla no cabe. No es una vista
// degradada: es la misma pieza y el mismo dato con otra forma, y sus bloques
// siguen siendo accionables con el mismo onSelect.
function Agenda({
  days,
  byDay,
  palette,
  onSelect,
}: {
  days: DayCode[];
  byDay: Map<DayCode, Block[]>;
  palette: Map<string, number>;
  onSelect?: (block: PlacedBlock) => void;
}) {
  return (
    <div className="divide-line divide-y">
      {days.map((day) => {
        const placed = layoutDay(byDay.get(day) ?? []);
        return (
          <section key={day} className="px-3 py-2">
            <h4 className="text-muted mb-1.5 text-xs font-medium">{DAY_LABELS[day]}</h4>
            {placed.length === 0 ? (
              <p className="text-muted/70 text-xs">Sin clases</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {placed.map((block) => {
                  const color = hueColor(palette.get(block.code) ?? 0);
                  const clash = block.conflictsWith.length > 0;
                  const Fila = onSelect ? 'button' : 'div';
                  return (
                    <li key={block.id}>
                      <Fila
                        {...(onSelect
                          ? {
                              type: 'button' as const,
                              onClick: () => onSelect(block),
                              'aria-label': `${block.code} ${block.title}, ${block.start} a ${block.end}`,
                            }
                          : {})}
                        className={`focus-visible:outline-accent flex w-full items-baseline gap-2 rounded-[var(--radius)] px-2 py-1.5 text-left text-xs focus-visible:outline-2 ${
                          block.ghost ? 'opacity-45' : ''
                        }`}
                        style={{
                          background: `color-mix(in oklch, ${color} 18%, var(--surface))`,
                          borderLeft: `3px solid ${color}`,
                          outline: clash ? '1px solid var(--closed)' : undefined,
                        }}
                      >
                        <span className="tabular w-24 shrink-0 font-mono text-[11px] opacity-80">
                          {block.start}–{block.end}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{block.code}</span>{' '}
                          <span className="opacity-80">{block.title}</span>
                          {block.room && <span className="block text-[11px] opacity-70">{block.room}</span>}
                        </span>
                        {clash && <span className="text-closed shrink-0 text-[11px] font-medium">choca</span>}
                      </Fila>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

// `animate` prende el único momento orquestado de la app (plan §3): el bloque
// "aterrizando" al elegir una sección en planner/builder. La animación corre
// al montar; como la key de cada bloque incluye el classNbr, un swap de
// sección remonta el bloque y la repite. Off por defecto (horario, carrito).
export function WeeklyGrid({
  blocks,
  animate = false,
  onSelect,
}: {
  blocks: Block[];
  animate?: boolean;
  /** Cuando se pasa, cada bloque es accionable por click, tap y teclado. */
  onSelect?: (block: Block) => void;
}) {
  const byDay = new Map<DayCode, Block[]>(WEEK_DAYS.map((d) => [d, []]));
  for (const block of blocks) byDay.get(block.day)?.push(block);

  // El sábado solo ocupa una columna si alguien tiene clases ahí.
  const days = WEEK_DAYS.filter((d, i) => i < 5 || (byDay.get(d)?.length ?? 0) > 0);

  // La ventana se calcula sobre los bloques REALES: un fantasma es una vista
  // previa y no debería estirar la grilla mientras el mouse pasa por encima.
  const reales = blocks.filter((block) => !block.ghost);
  const { startHour, endHour } = timeWindow(reales.length > 0 ? reales : blocks);
  const slots = ((endHour - startHour) * 60) / SLOT_MINUTES;
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  const rowFor = (hhmm: string) => toGridLine(hhmm, startHour, SLOT_MINUTES);
  const palette = paletteFor(blocks);

  return (
    <div className="border-line bg-surface weekly-grid-host overflow-hidden rounded-[var(--radius)] border">
      {/* Angosto: agenda por día. Ancho: grilla. Lo decide el ancho del
          CONTENEDOR (container query en index.css), no el de la ventana. */}
      <div className="weekly-agenda">
        <Agenda days={days} byDay={byDay} palette={palette} onSelect={onSelect} />
      </div>
      {/* En mobile cada día ocupa ~68vw y esto scrollea con snap (el "carrusel
          de días" del plan); en desktop las columnas entran juntas.
          scrollPaddingLeft compensa la canaleta sticky: sin esto, el snap alinea
          el día contra el borde del contenedor y la canaleta se lo come. */}
      <div className="weekly-grid-scroll snap-x snap-mandatory overflow-x-auto" style={{ scrollPaddingLeft: GUTTER }}>
        <div
          className="weekly-grid grid"
          style={{
            gridTemplateColumns: `${GUTTER} repeat(${days.length}, minmax(var(--day-min), 1fr))`,
            gridTemplateRows: `auto repeat(${slots}, minmax(0.5rem, 1fr))`,
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
          {hours.map((h, i) => (
            <div
              key={h}
              className="bg-surface border-line/60 text-muted tabular sticky left-0 z-20 flex items-start justify-end border-t pr-2 text-right font-mono text-[10px]"
              style={{ gridColumn: 1, gridRow: hourRow(i) }}
            >
              <span className="-translate-y-1/2">{String(h).padStart(2, '0')}:00</span>
            </div>
          ))}

          {/* Hairlines de hora a lo ancho de los días (sin sombras: regla de
              composición del sistema de diseño). */}
          {hours.map((h, i) => (
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
              style={{ gridColumn: i + 2, gridRow: `2 / span ${slots}` }}
              aria-hidden
            />
          ))}

          {days.flatMap((day, i) =>
            layoutDay(byDay.get(day) ?? []).map((block) => (
              <BlockCard
                key={block.id}
                block={block}
                column={i + 2}
                hue={palette.get(block.code) ?? 0}
                animate={animate}
                rowFor={rowFor}
                onSelect={onSelect}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
