import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, MapPin } from 'lucide-react';
import { DAY_LABELS, formatRange12, formatTime12, toMinutes, type DayCode } from '../../../src/shared/meetings.ts';
import { hueColor } from '../lib/color.ts';
import {
  FILAS_POR_HORA,
  bandLine,
  bandRows,
  foldBands,
  layoutDay,
  paletteFor,
  timeWindow,
  visibleDays,
  type Band,
  type Block,
  type PlacedBlock,
} from '../lib/grid.ts';

// El corazón visual de la app: CSS Grid propio en vez de una librería de
// calendario. Control total del color, los choques y el responsive a cambio de
// unas 350 líneas y 0KB de dependencias.
//
// Lo que lo separa de la versión anterior, y por qué:
//
//   1. VENTANA DERIVADA Y BANDAS PLEGADAS. Era 7:00 a 22:00 fijo: quince horas
//      de grilla para mostrar seis. La ventana ahora sale de los bloques, y
//      además las horas que ningún día usa se pliegan en una tira con su
//      cuenta. Un hueco de cinco horas es tu tarde libre: es información, así
//      que la tira lo dice y se despliega, no se borra.
//   2. FILA FIJA DE MEDIA HORA en vez de 1fr. Las 1319 reuniones del catálogo
//      empiezan y terminan en hora en punto: no existe el bloque de 45 minutos,
//      así que los slots de 15 eran sesenta filas para quince posiciones. Y con
//      1fr el bloque más corto de la pantalla decidía el alto de toda la grilla.
//   3. DÍAS QUE SALEN DE LOS BLOQUES. Con el horario real quedan dos columnas y
//      a 393px son anchas de verdad. Un bloque en domingo dejaba de dibujarse
//      en silencio porque la lista de días no tenía la clave.
//   4. EL CHOQUE SE LEE SIN LEER: contorno, glifo y la palabra dentro del
//      bloque, más un panel que lo dice en prosa. El motivo vivía solo en un
//      atributo title, que en teléfono no existe y con teclado tampoco.
//   5. EL COMPONENTE SE DISTINGUE POR FORMA, no por tono: la barra de una
//      teórica es sólida y la de una práctica segmentada. Hace falta porque el
//      color ahora se reparte sobre las materias visibles y puede cambiar entre
//      pantallas; por eso el código va SIEMPRE escrito en el bloque.
//   6. LA GRILLA ES UNA SOLA PARADA DE TABULACIÓN con foco rotativo por
//      flechas, no doce paradas que hay que atravesar para llegar al botón de
//      abajo.
//   7. LA HORA VIVE DENTRO DE SU CELDA, arriba y pegada a la línea que abre.
//      Montarla sobre la línea (estilo Google Calendar) exigía desplazarla
//      media línea hacia arriba y rellenar la cabecera para que la primera no
//      chocara, y aun así se leía torcida. Una sola regla por hora cruza la
//      canaleta y los días.
//   8. EL BLOQUE SE LEE COMO UN EVENTO: anclado arriba, el nombre de la materia
//      primero, el código como identificador, el aula porque es lo que se busca
//      entre dos clases. La hora solo cuando el bloque es tan corto que la
//      canaleta no la dice sola.

// Alto de una fila de media hora. Fijo y no 1fr: así la grilla mide lo que
// tiene que medir y el bloque más corto deja de decidir el alto de todo.
const FILA = '1.75em';
// La tira de una banda plegada. Más baja que una hora real para que se lea como
// lo que es: un salto, no tiempo.
const FILA_PLEGADA = '2.9em';
// La canaleta de horas. Con AM/PM la etiqueta más ancha es "12 a.m.", que a
// 10px mono no entra en las 3.25rem que bastaban para "12:00".
const GUTTER = '4.25rem';
// Un bloque más corto que esto no cruza suficientes líneas de la canaleta como
// para leer su hora de ahí, así que la lleva escrita.
const MINUTOS_SIN_HORA = 90;

// JS cuenta los días desde el domingo; el catálogo desde el lunes.
const DIA_DE_JS: DayCode[] = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

export type BloqueDetalle = PlacedBlock & { hue: number };

// La barra de color dice el componente por FORMA. Una teórica es sólida, una
// práctica segmentada. El tono dice la materia; la forma dice qué parte de esa
// materia es, así que ninguna de las dos cosas depende de distinguir dos tonos.
function barra(color: string, component: string | null): string {
  return `3px ${component === 'PRA' ? 'dashed' : 'solid'} ${color}`;
}

function Bloque({
  block,
  column,
  hue,
  bands,
  animate,
  selected,
  focused,
  onSelect,
}: {
  block: PlacedBlock;
  column: number;
  hue: number;
  bands: Band[];
  animate: boolean;
  selected: boolean;
  focused: boolean;
  onSelect?: (block: BloqueDetalle) => void;
}) {
  const color = hueColor(hue);
  const choca = block.conflictsWith.length > 0;
  const etiqueta = [
    `${block.code} ${block.title}`,
    formatRange12(block.start, block.end),
    block.room ?? 'aula no publicada',
    block.instructor ?? 'profesor no asignado',
    choca ? `choca con ${block.conflictsWith.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(', ');

  const corto = toMinutes(block.end) - toMinutes(block.start) < MINUTOS_SIN_HORA;

  return (
    <button
      type="button"
      disabled={!onSelect}
      tabIndex={onSelect && focused ? 0 : -1}
      aria-label={onSelect ? etiqueta : undefined}
      aria-pressed={onSelect && selected ? true : undefined}
      // El click sincroniza el índice de foco: sin esto, tocar un bloque y
      // después apretar Enter abría el detalle del que tuviera el índice.
      onClick={onSelect ? () => onSelect({ ...block, hue }) : undefined}
      // Un botón centra su contenido en vertical; un evento se lee desde el
      // borde donde empieza. De ahí el flex-col con items-start.
      className={`flex flex-col items-start gap-0.5 overflow-hidden rounded-[var(--radius)] py-1 pr-1.5 pl-1.5 text-left text-[11px] leading-tight ${
        block.ghost ? 'pointer-events-none z-20' : 'z-10'
      } ${animate && !block.ghost ? 'block-land' : ''} ${
        onSelect ? 'cursor-pointer hover:brightness-95 dark:hover:brightness-110' : ''
      } ${
        focused ? 'outline-accent outline-2 outline-offset-1' : ''
      }`}
      style={{
        gridColumn: column,
        gridRow: `${bandLine(bands, block.start)} / ${bandLine(bands, block.end)}`,
        // El fantasma va ENCIMA y con inset, fuera del reparto de carriles: no
        // parte la columna en dos justo cuando estás comparando, y el inset
        // deja ver la barra y el contorno del bloque real que está pisando.
        marginLeft: block.ghost ? '0.3em' : `${(block.lane * 100) / block.lanes}%`,
        marginRight: block.ghost ? '0.3em' : undefined,
        width: block.ghost ? undefined : `calc(${100 / block.lanes}% - 2px)`,
        background: `color-mix(in oklch, ${color} ${block.ghost ? 12 : 22}%, var(--surface))`,
        // El fantasma se distingue también por forma, no solo por opacidad.
        border: block.ghost ? `1px dashed ${color}` : undefined,
        borderLeft: barra(color, block.component),
        outline: choca ? '1.5px solid var(--closed)' : undefined,
        // Seleccionado NO se vuelve acento. Acá el color ES la materia: si al
        // elegir se vuelve azul, se pierde la única pista de qué bloque es de
        // qué materia justo mientras se comparan. Anillo y punto.
        boxShadow: selected ? 'inset 0 0 0 1.5px var(--accent)' : undefined,
      }}
    >
      {/* El nombre es lo que se busca; hasta dos líneas y en un bloque corto una. */}
      <span className={`w-full font-medium ${corto ? 'truncate' : 'line-clamp-2'}`}>{block.title}</span>
      <span className="tabular flex w-full items-center gap-1 font-mono text-[10px] opacity-70">
        <span className="truncate">
          {block.code}
          {/* El componente se dice con palabra además de con la forma de la
              barra: una forma es una pista, la palabra es el dato. */}
          {block.component && ` · ${block.component}`}
        </span>
        {corto && <span className="shrink-0">· {formatRange12(block.start, block.end)}</span>}
        {selected && <span className="bg-accent ml-auto size-1.5 shrink-0 rounded-full" aria-hidden />}
      </span>
      {!corto && (
        <span className="text-muted flex w-full items-center gap-1 text-[10px]">
          <MapPin className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{block.room ?? 'aula no publicada'}</span>
        </span>
      )}
      {choca && (
        <span className="text-closed mt-auto flex items-center gap-1 text-[10px] font-medium">
          <AlertTriangle className="size-3 shrink-0" aria-hidden />
          choca
        </span>
      )}
    </button>
  );
}

// La tira de una banda plegada. Dice cuánto se comió y se despliega: un hueco
// de cinco horas es información sobre tu semana, no ruido que haya que borrar.
function Plegada({
  band,
  columnas,
  fila,
  onDesplegar,
}: {
  band: Extract<Band, { kind: 'plegada' }>;
  columnas: number;
  fila: number;
  onDesplegar: () => void;
}) {
  const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
  return (
    <button
      type="button"
      onClick={onDesplegar}
      className="border-line/60 text-muted hover:bg-surface-2 hover:text-fg z-10 flex items-center gap-2 border-y border-l border-dashed px-2 text-[10px]"
      style={{ gridColumn: `2 / span ${columnas}`, gridRow: fila }}
    >
      <span className="grid size-3 shrink-0 place-items-center rounded-[3px] border border-current/70 text-[9px] leading-none" aria-hidden>
        +
      </span>
      <span>
        {band.hours} h libres, <span className="tabular font-mono">{formatRange12(hh(band.fromHour), hh(band.toHour))}</span>
      </span>
      <span className="text-accent ml-auto font-medium">mostrar</span>
    </button>
  );
}

// La etiqueta de una hora: el número en tinta, el sufijo apagado. "10 a.m." es
// una sola cosa para la voz y dos para el ojo.
function Hora({ hour }: { hour: number }) {
  const [numero, sufijo] = formatTime12(`${String(hour).padStart(2, '0')}:00`).split(' ');
  return (
    <span className="tabular font-mono text-[10px] leading-none whitespace-nowrap">
      <span className="text-fg font-semibold">{numero}</span>
      {sufijo && <span className="text-muted ml-0.5">{sufijo}</span>}
    </span>
  );
}

/**
 * `animate` prende el único momento orquestado de la app: el bloque aterrizando
 * al elegir una sección. `selectedIds` marca lo elegido con anillo y punto.
 * `now` resalta el día de hoy y traza la hora actual: solo tiene sentido sobre
 * el horario inscrito, no sobre uno que se está armando.
 */
export function WeeklyGrid({
  blocks,
  animate = false,
  onSelect,
  selectedIds,
  now,
}: {
  blocks: Block[];
  animate?: boolean;
  /** Cuando se pasa, cada bloque es accionable por click, tap y teclado. */
  onSelect?: (block: BloqueDetalle) => void;
  /** classNbr de las secciones elegidas: anillo de acento más punto. */
  selectedIds?: ReadonlySet<string>;
  /** El momento presente: día resaltado en la cabecera y línea de la hora. */
  now?: Date;
}) {
  const [verTodos, setVerTodos] = useState(false);
  const [desplegadas, setDesplegadas] = useState<ReadonlySet<number>>(new Set<number>());
  const [foco, setFoco] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);

  // La ventana, los días y las bandas salen de TODOS los bloques, fantasma
  // incluido. Derivarlas solo de los reales hacía que una vista previa fuera de
  // la ventana, o en un día sin clases, se descartara en silencio: justo el
  // caso de comparar una candidata de la noche contra un horario de mañana.
  const days = useMemo(() => visibleDays(blocks, { all: verTodos }), [blocks, verTodos]);

  const byDay = useMemo(() => {
    const map = new Map<DayCode, Block[]>(days.map((d) => [d, []]));
    for (const block of blocks) map.get(block.day)?.push(block);
    return map;
  }, [blocks, days]);

  const { startHour, endHour } = useMemo(() => timeWindow(blocks), [blocks]);

  const bands = useMemo(() => {
    const plegadas = foldBands(blocks, { startHour, endHour });
    // Una tira desplegada vuelve a ser sus horas: el estado vive acá y no en la
    // función pura, que no tiene por qué saber qué abrió el usuario.
    return plegadas.flatMap<Band>((band) =>
      band.kind === 'plegada' && desplegadas.has(band.fromHour)
        ? Array.from({ length: band.hours }, (_, i) => ({ kind: 'hora' as const, hour: band.fromHour + i }))
        : [band]
    );
  }, [blocks, startHour, endHour, desplegadas]);

  const palette = useMemo(() => paletteFor(blocks), [blocks]);
  const colocados = useMemo(() => days.map((day) => layoutDay(byDay.get(day) ?? [])), [days, byDay]);
  // El orden de tabulación es el de lectura: día por día, de arriba abajo.
  const navegables = useMemo(() => colocados.flat().filter((block) => !block.ghost), [colocados]);
  const choques = useMemo(() => navegables.filter((block) => block.conflictsWith.length > 0), [navegables]);

  // El día de hoy solo se marca si está en pantalla; la línea de la hora solo
  // si cae dentro de una banda visible, no en una plegada ni fuera de la ventana.
  const hoy = now ? DIA_DE_JS[now.getDay()] : undefined;
  const columnaHoy = hoy ? days.indexOf(hoy) : -1;
  const lineaAhora = useMemo(() => {
    if (!now || columnaHoy < 0) return null;
    const hora = now.getHours();
    if (!bands.some((b) => b.kind === 'hora' && b.hour === hora)) return null;
    return { fila: bandLine(bands, `${String(hora).padStart(2, '0')}:00`), fraccion: now.getMinutes() / 60 };
  }, [now, columnaHoy, bands]);

  const filas = bands.map((band) => (band.kind === 'hora' ? `${FILA} ${FILA}` : FILA_PLEGADA)).join(' ');
  const filaDe = (i: number) =>
    bands.slice(0, i).reduce((n, b) => n + (b.kind === 'hora' ? FILAS_POR_HORA : 1), 0) + 2;

  // La grilla es UNA parada de tabulación con foco rotativo. Doce paradas
  // obligan a atravesar el horario entero para llegar al botón de abajo.
  const teclas = (event: React.KeyboardEvent) => {
    if (!onSelect || navegables.length === 0) return;
    const paso: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (event.key in paso) {
      event.preventDefault();
      setFoco((i) => (i + paso[event.key] + navegables.length) % navegables.length);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const block = navegables[foco];
      if (block) onSelect({ ...block, hue: palette.get(block.code) ?? 0 });
    }
  };

  const irAlDia = (indice: number) => {
    const caja = scroller.current;
    if (!caja) return;
    const paso = (caja.scrollWidth - caja.clientWidth) / Math.max(1, days.length - 1);
    caja.scrollTo({ left: paso * indice, behavior: 'smooth' });
  };

  return (
    <div className="border-line bg-surface weekly-grid-host overflow-hidden rounded-[var(--radius)] border">
      {/* Los chips desplazan la grilla al día tocado. Existen solo cuando hay
          más días de los que entran; con dos columnas no hay nada que navegar. */}
      {days.length > 2 && (
        <div className="weekly-day-chips border-line flex gap-1 overflow-x-auto border-b px-2 py-1.5">
          {days.map((day, i) => (
            <button
              key={day}
              type="button"
              onClick={() => irAlDia(i)}
              className="border-line text-muted hover:bg-surface-2 hover:text-fg min-w-11 shrink-0 rounded-full border px-2 py-1 text-[11px]"
            >
              {DAY_LABELS[day]}
            </button>
          ))}
        </div>
      )}

      <div ref={scroller} className="weekly-grid-scroll overflow-x-auto" style={{ scrollPaddingLeft: GUTTER }}>
        <div
          role={onSelect ? 'grid' : undefined}
          tabIndex={onSelect ? 0 : undefined}
          onKeyDown={teclas}
          aria-label={onSelect ? 'Horario semanal, movete con las flechas' : undefined}
          className="weekly-grid focus-visible:outline-accent grid focus-visible:outline-2"
          style={{
            gridTemplateColumns: `${GUTTER} repeat(${days.length}, minmax(var(--day-min), 1fr))`,
            gridTemplateRows: `auto ${filas}`,
          }}
        >
          <div className="bg-surface border-line sticky left-0 z-10 border-b" style={{ gridColumn: 1, gridRow: 1 }} />
          {days.map((day, i) => (
            <div
              key={day}
              className={`bg-surface border-line flex items-center justify-center gap-1.5 border-b border-l px-2 py-1.5 text-xs font-medium ${
                i === columnaHoy ? 'text-accent' : 'text-muted'
              }`}
              style={{ gridColumn: i + 2, gridRow: 1 }}
            >
              {DAY_LABELS[day]}
              {/* El número del día dice que "hoy" es una fecha y no un color. */}
              {i === columnaHoy && now && (
                <span className="bg-accent text-accent-fg tabular grid size-4 place-items-center rounded-full text-[10px] font-semibold">
                  {now.getDate()}
                </span>
              )}
            </div>
          ))}

          {/* Canaleta y hairlines. La etiqueta vive DENTRO de la celda de su
              hora, arriba y pegada a la línea que la abre: una clase que
              arranca a las 10 empieza en la misma línea que dice "10 a.m.". La
              regla de cada hora cruza canaleta y días como una sola. */}
          {bands.map((band, i) =>
            band.kind === 'plegada' ? (
              <Plegada
                key={`p${band.fromHour}`}
                band={band}
                columnas={days.length}
                fila={filaDe(i)}
                onDesplegar={() => setDesplegadas((s) => new Set(s).add(band.fromHour))}
              />
            ) : (
              <div key={`h${band.hour}`} className="contents">
                <div
                  className="bg-surface border-line/60 sticky left-0 z-20 border-t pt-1 pl-2"
                  style={{ gridColumn: 1, gridRow: `${filaDe(i)} / span ${FILAS_POR_HORA}` }}
                >
                  <Hora hour={band.hour} />
                </div>
                <div
                  className="border-line/60 pointer-events-none border-t"
                  style={{ gridColumn: `2 / span ${days.length}`, gridRow: `${filaDe(i)} / span ${FILAS_POR_HORA}` }}
                  aria-hidden
                />
              </div>
            )
          )}

          {days.map((day, i) => (
            <div
              key={`sep${day}`}
              className="border-line pointer-events-none border-l"
              style={{ gridColumn: i + 2, gridRow: `2 / span ${bandRows(bands)}` }}
              aria-hidden
            />
          ))}

          {/* La hora actual, sobre los días y por encima de los bloques. El
              punto marca la columna de hoy; la línea sigue por el resto para
              leer qué está pasando ahora en toda la semana. */}
          {lineaAhora && (
            <div
              className="pointer-events-none relative z-30"
              style={{ gridColumn: `2 / span ${days.length}`, gridRow: `${lineaAhora.fila} / span ${FILAS_POR_HORA}` }}
              aria-hidden
            >
              <div className="bg-closed absolute right-0 left-0 h-0.5" style={{ top: `${lineaAhora.fraccion * 100}%` }}>
                <span
                  className="bg-closed absolute top-1/2 size-2.5 -translate-y-1/2 rounded-full"
                  style={{ left: `calc(${(columnaHoy * 100) / days.length}% - 0.3125rem)` }}
                />
              </div>
            </div>
          )}

          {colocados.flatMap((delDia, i) =>
            delDia.map((block) => (
              <Bloque
                key={block.id}
                block={block}
                column={i + 2}
                hue={palette.get(block.code) ?? 0}
                bands={bands}
                animate={animate}
                selected={selectedIds?.has(block.classNbr) ?? false}
                focused={!!onSelect && !block.ghost && navegables[foco]?.id === block.id}
                onSelect={onSelect}
              />
            ))
          )}
        </div>
      </div>

      {/* El choque dicho en prosa, no solo pintado. Quien no distingue el rojo
          o no ve la trama necesita la frase. */}
      {choques.length > 0 && (
        <div className="border-closed/40 bg-closed/10 text-closed border-t px-3 py-2 text-xs" role="status">
          <p className="flex items-start gap-1.5 font-medium">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {choques.length === 1 ? 'Hay un choque' : `Hay ${choques.length} choques`} en este horario.
          </p>
          <ul className="mt-1 flex flex-col gap-0.5 pl-5">
            {[...new Map(choques.map((b) => [`${b.code}-${b.day}-${b.start}`, b])).values()].map((block) => (
              <li key={block.id}>
                {block.code} el {DAY_LABELS[block.day]} de {formatRange12(block.start, block.end)} se cruza con{' '}
                {block.conflictsWith.join(', ')}.
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Ver los seis días es siempre posible: ocultar un día vacío no puede
          significar que dejes de poder mirarlo. */}
      <div className="border-line flex justify-end gap-3 border-t px-2 py-1">
        {/* Desplegar era un viaje de ida: una tira abierta volvía a costar
            todas sus filas y no había forma de recuperarlas. */}
        {desplegadas.size > 0 && (
          <button
            type="button"
            onClick={() => setDesplegadas(new Set<number>())}
            className="text-muted hover:text-fg min-h-11 text-[11px]"
          >
            Plegar las horas vacías
          </button>
        )}
        <button
          type="button"
          onClick={() => setVerTodos((v) => !v)}
          className="text-muted hover:text-fg min-h-11 text-[11px]"
        >
          {verTodos ? 'Ver solo los días con clase' : 'Ver los seis días'}
        </button>
      </div>
    </div>
  );
}
