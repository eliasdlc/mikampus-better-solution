import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, CircleDot, CircleHelp, Clock3, Lock, type LucideIcon } from 'lucide-react';
import { fetchTermContext, fetchTermPhase, saveTermEvents } from '../lib/api.ts';
import { Capacidad, capabilityOf } from '../components/Capacidad.tsx';
import { FaseBadge, PHASE_LABELS } from '../components/FaseBadge.tsx';
import { TermBadge } from '../components/TermBadge.tsx';
import { dayOf, isoToDayNumber } from '../../../src/shared/terms.ts';
import {
  ALWAYS_ON_CAPABILITY_IDS,
  GATED_CAPABILITY_IDS,
  TERM_EVENT_IDS,
  TERM_EVENT_LABELS,
  type CapabilityId,
  type TermEventId,
  type TermEventSource,
} from '../../../src/shared/termPhase.ts';
import type { TermEventInput, TermEventRow, TermPhaseResponse } from '../../../src/shared/schemas.ts';

// En qué etapa del ciclo estás y qué podés hacer en ella.
//
// Toda la regla vive en el backend (shared/termPhase.ts): acá no se compara una
// sola fecha para decidir si algo está abierto. La pantalla solo tiene tres
// trabajos, y los tres son de presentación:
//
//   1. Decir dónde estás sin disfrazar una etapa deducida de una fechada.
//   2. Mostrar la línea del ciclo marcando lo que NO se sabe como desconocido,
//      nunca en blanco ni con una fecha de relleno.
//   3. Dar la salida de emergencia: cargar a mano la fecha que el portal no
//      publica, mientras el scraper de plazos no la confirme.

// ── Fechas legibles ─────────────────────────────────────────────────────────

// Una fecha de calendario no tiene hora, así que se formatea en UTC: leída en
// la zona local (Santo Domingo es UTC-4), "2026-09-03" se dibujaría como el 2.
// El número de día por 86.400.000 es justo la medianoche UTC de esa fecha, así
// que la conversión reusa el mismo parser que usa el backend.
const LARGA = new Intl.DateTimeFormat('es-DO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const CORTA = new Intl.DateTimeFormat('es-DO', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function fecha(iso: string, formato: Intl.DateTimeFormat = LARGA): string {
  const dia = isoToDayNumber(iso);
  return dia === null ? iso : formato.format(dia * 86_400_000);
}

function hoyISO(hoy: Date): string {
  return `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`;
}

// "en 2 días" y no un número suelto: lo que se decide con esto es si hay tiempo
// de hacer algo, no cuántos días hay en el intervalo.
function cuanto(dias: number): string {
  if (dias < 0) return 'ya pasó';
  if (dias === 0) return 'hoy';
  if (dias === 1) return 'mañana';
  return `en ${dias} días`;
}

// TERM_EVENT_LABELS nombra la etapa dentro de una frase ("cerró la inscripción").
// Un título de lista no lleva artículo, y quitárselo es preferible a mantener
// una segunda tabla de nombres que el día de mañana diga otra cosa.
function titulo(event: TermEventId): string {
  const sinArticulo = TERM_EVENT_LABELS[event].replace(/^(la|el) /, '');
  return sinArticulo.charAt(0).toUpperCase() + sinArticulo.slice(1);
}

// ── La línea del ciclo ──────────────────────────────────────────────────────

type EstadoVentana = 'abierta' | 'futura' | 'vencida' | 'desconocida';

type Ventana = {
  event: TermEventId;
  startsOn: string | null;
  endsOn: string | null;
  sources: TermEventSource[];
  estado: EstadoVentana;
};

const ESTADOS = {
  abierta: { Icono: CircleDot, texto: 'Abierta', clase: 'text-open' },
  futura: { Icono: Clock3, texto: 'Por venir', clase: 'text-fg' },
  vencida: { Icono: Lock, texto: 'Cerrada', clase: 'text-muted' },
  desconocida: { Icono: CircleHelp, texto: 'Sin fecha', clase: 'text-waitlist' },
} as const satisfies Record<EstadoVentana, { Icono: LucideIcon; texto: string; clase: string }>;

/**
 * Las seis etapas del ciclo con su ventana y su estado contra hoy.
 *
 * Qué está abierto lo dice el servidor (`phase.open`) y acá no se vuelve a
 * decidir: dos implementaciones de la misma regla terminan discrepando. Lo
 * único que se calcula localmente es si una ventana que no está abierta ya pasó
 * o todavía no llegó, que es una comparación y no una regla.
 *
 * Varias sesiones del mismo ciclo pueden traer la misma etapa, así que la
 * ventana que se muestra es la más ancha, igual que la que usó el backend: una
 * fecha faltante ensancha, porque no saber cuándo abre no es saber que ya abrió.
 */
function lineaDelCiclo(phase: TermPhaseResponse, hoy: number): Ventana[] {
  return TERM_EVENT_IDS.map((event) => {
    const filas = phase.events.filter((fila) => fila.event === event);
    const startsOn = filas.length && filas.every((f) => f.startsOn !== null)
      ? filas.map((f) => f.startsOn).sort()[0] ?? null
      : null;
    const endsOn = filas.length && filas.every((f) => f.endsOn !== null)
      ? filas.map((f) => f.endsOn).sort().at(-1) ?? null
      : null;
    const inicio = startsOn === null ? null : isoToDayNumber(startsOn);

    const estado: EstadoVentana =
      startsOn === null && endsOn === null
        ? 'desconocida'
        : phase.open.includes(event)
          ? 'abierta'
          : inicio !== null && inicio > hoy
            ? 'futura'
            : 'vencida';

    return {
      event,
      startsOn,
      endsOn,
      sources: [...new Set(filas.map((f) => f.source))],
      estado,
    };
  });
}

function rango(ventana: { startsOn: string | null; endsOn: string | null }): string {
  const desde = ventana.startsOn ? fecha(ventana.startsOn, CORTA) : null;
  const hasta = ventana.endsOn ? fecha(ventana.endsOn, CORTA) : null;
  if (desde && hasta) return `${desde} a ${hasta}`;
  if (desde) return `Desde el ${desde}, sin fecha de cierre`;
  if (hasta) return `Hasta el ${hasta}, sin fecha de apertura`;
  return 'El calendario que mikampus conoce no dice cuándo es';
}

function procedencia(sources: readonly TermEventSource[]): string | null {
  const portal = sources.includes('portal');
  const usuario = sources.includes('usuario');
  if (portal && usuario) return 'Parte lo publicó el portal, parte la cargaste vos';
  if (portal) return 'Lo publicó el portal';
  if (usuario) return 'La cargaste vos';
  return null;
}

// ── Las capacidades ─────────────────────────────────────────────────────────

// Qué es cada capacidad y desde qué pantalla se hace. El retiro total no tiene
// pantalla a propósito: mikampus no lo ejecuta (es presencial), así que su fila
// informa la fecha límite y no ofrece ningún botón.
const CAPACIDADES = {
  'mandar-al-carrito': { label: 'Mandar materias al carrito', donde: '/inscripcion' },
  inscribir: { label: 'Inscribir el carrito', donde: '/inscripcion' },
  'programar-inscripcion': { label: 'Programar la inscripción a una hora', donde: '/inscripcion' },
  'vigilar-cupo': { label: 'Vigilar un cupo', donde: '/inscripcion' },
  'dar-de-baja': { label: 'Dar de baja una materia', donde: '/horario' },
  'retiro-total': { label: 'Retirar el ciclo completo', donde: null },
  // Apuntaban a /mesa, que no tenía ni recomendador ni export: la pantalla de
  // capacidades prometía algo que el destino no cumplía. Los tres viven en la
  // etapa 'plan' del recorrido.
  planear: { label: 'Planear el ciclo', donde: '/inscripcion' },
  recomendar: { label: 'Pedir recomendaciones', donde: '/inscripcion' },
  'buscar-catalogo': { label: 'Buscar en el catálogo', donde: '/' },
  'exportar-plan': { label: 'Exportar el plan e imprimirlo', donde: '/inscripcion' },
  sincronizar: { label: 'Traer tus datos del portal', donde: '/ajustes' },
  'ver-notas': { label: 'Ver tus notas', donde: '/academico' },
} as const satisfies Record<CapabilityId, { label: string; donde: string | null }>;

const CHIP_ESTADO = {
  habilitada: { texto: 'Disponible', clase: 'text-open' },
  advertida: { texto: 'Con aviso', clase: 'text-waitlist' },
  cerrada: { texto: 'Apagada', clase: 'text-closed' },
} as const;

function IrA({ path, label }: { path: string; label: string }) {
  return (
    <Link
      to={path}
      className="border-line hover:bg-surface-2 inline-flex shrink-0 items-center gap-1 rounded-full border px-3 py-1 text-xs"
      aria-label={`Ir a ${label.toLowerCase()}`}
    >
      Ir
      <ArrowRight className="size-3" aria-hidden />
    </Link>
  );
}

function FilaCapacidad({ id, phase }: { id: CapabilityId; phase: TermPhaseResponse }) {
  const estado = capabilityOf(phase, id);
  const { label, donde } = CAPACIDADES[id];
  const chip = CHIP_ESTADO[estado.state];
  return (
    <li className="px-4 py-3">
      <Capacidad state={estado}>
        {(blocked) => (
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <p className="text-sm font-medium">{label}</p>
            <div className="ml-auto flex items-center gap-3">
              <span className={`text-xs ${chip.clase}`}>{chip.texto}</span>
              {/* Un enlace hacia una pantalla donde el control está apagado sería
                  un viaje a un botón gris: cuando la capacidad está cerrada, la
                  fila explica y no invita. */}
              {donde && !blocked && <IrA path={donde} label={label} />}
            </div>
          </div>
        )}
      </Capacidad>
    </li>
  );
}

// ── El calendario que se carga a mano ───────────────────────────────────────

// La sesión con la que se guarda lo que se tipea acá. El calendario académico
// de PUCMM publica las etapas de la sesión regular; una sesión de ocho semanas
// que ya estuviera guardada se respeta y se edita en su propia fila.
const SESION = 'Regular Academic Session';

type Fila = { clave: string; event: TermEventId; session: string; startsOn: string; endsOn: string };

/**
 * Las filas editables del formulario: lo que el estudiante ya cargó, más una
 * fila vacía por cada etapa que todavía no tiene una suya.
 *
 * Solo entran las filas source='usuario' porque el PUT reemplaza exactamente
 * ese conjunto: mandar de vuelta lo que dijo el portal lo convertiría en un dato
 * tipeado a mano, y no mandarlo borraría lo que el estudiante sí escribió.
 */
function filasEditables(events: readonly TermEventRow[]): Fila[] {
  const mias = events.filter((e) => e.source === 'usuario');
  return TERM_EVENT_IDS.flatMap((event) => {
    const propias = mias.filter((e) => e.event === event);
    if (!propias.length) return [{ clave: `${event}|${SESION}`, event, session: SESION, startsOn: '', endsOn: '' }];
    return propias.map((e) => ({
      clave: `${event}|${e.session}`,
      event,
      session: e.session,
      startsOn: e.startsOn ?? '',
      endsOn: e.endsOn ?? '',
    }));
  });
}

function conFecha(fila: Fila): boolean {
  return fila.startsOn !== '' || fila.endsOn !== '';
}

function CalendarioAMano({
  phase,
  term,
  queryKey,
}: {
  phase: TermPhaseResponse;
  term: string;
  queryKey: readonly unknown[];
}) {
  const queryClient = useQueryClient();

  // `null` significa "sin ediciones locales", y es lo que hace que la pantalla
  // siga al servidor sola: al guardar, o al cambiar de ciclo, vuelve a null y
  // el formulario muestra lo guardado sin un segundo estado que sincronizar.
  const delServidor = useMemo(() => filasEditables(phase.events), [phase.events]);
  const notaGuardada = phase.events.find((e) => e.source === 'usuario' && e.sourceNote)?.sourceNote ?? '';
  const [editadas, setEditadas] = useState<Fila[] | null>(null);
  const [nota, setNota] = useState<string | null>(null);
  useEffect(() => {
    setEditadas(null);
    setNota(null);
  }, [delServidor]);

  const filas = editadas ?? delServidor;
  const notaActual = nota ?? notaGuardada;
  const tocado = editadas !== null || nota !== null;
  const invertida = filas.find((f) => f.startsOn && f.endsOn && f.startsOn > f.endsOn);

  const guardar = useMutation({
    mutationFn: () => {
      const payload: TermEventInput[] = filas.filter(conFecha).map((fila) => ({
        event: fila.event,
        session: fila.session,
        startsOn: fila.startsOn || null,
        endsOn: fila.endsOn || null,
        sourceNote: notaActual.trim() || null,
      }));
      return saveTermEvents(term, payload);
    },
    // El PUT responde con la fase ya recalculada, y por eso no hace falta una
    // segunda vuelta: escribir una fecha y ver qué se prendió con ella pasa a
    // ser el mismo instante.
    onSuccess: (fresh) => queryClient.setQueryData(queryKey, fresh),
  });

  const cambiar = (clave: string, campo: 'startsOn' | 'endsOn', valor: string) =>
    setEditadas(filas.map((fila) => (fila.clave === clave ? { ...fila, [campo]: valor } : fila)));

  return (
    <section className="border-line bg-surface rounded-[var(--radius)] border">
      <header className="border-line border-b px-4 py-3">
        <h2 className="text-sm font-medium">Cargar una fecha del calendario académico</h2>
        <p className="text-muted mt-1 text-xs">
          El portal solo publica tu ventana de inscripción. El resto de las etapas vive en el calendario académico de
          PUCMM, fuera del portal. Lo que cargues acá queda marcado como tuyo y los avisos lo dicen: nada se mezcla con
          lo que dijo el portal. Borrar una fecha es vaciar sus casillas y guardar.
        </p>
      </header>

      <ul className="divide-line divide-y">
        {filas.map((fila) => {
          const delPortal = phase.events.filter((e) => e.event === fila.event && e.source === 'portal');
          return (
            <li key={fila.clave} className="px-4 py-3">
              <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                <div className="min-w-40 flex-1">
                  <p className="text-sm font-medium">{titulo(fila.event)}</p>
                  {fila.session !== SESION && <p className="text-muted text-xs">{fila.session}</p>}
                  {delPortal.map((e) => (
                    <p key={e.session} className="text-muted mt-0.5 text-xs">
                      El portal publicó {rango(e).toLowerCase()}. Si escribís una fecha acá, mikampus usa la tuya.
                    </p>
                  ))}
                </div>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted">Abre</span>
                  <input
                    type="date"
                    value={fila.startsOn}
                    onChange={(e) => cambiar(fila.clave, 'startsOn', e.target.value)}
                    className="border-line bg-bg rounded-[var(--radius)] border px-2 py-1.5 text-sm"
                    aria-label={`Fecha de apertura de ${titulo(fila.event).toLowerCase()}`}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted">Cierra</span>
                  <input
                    type="date"
                    value={fila.endsOn}
                    onChange={(e) => cambiar(fila.clave, 'endsOn', e.target.value)}
                    className="border-line bg-bg rounded-[var(--radius)] border px-2 py-1.5 text-sm"
                    aria-label={`Fecha de cierre de ${titulo(fila.event).toLowerCase()}`}
                  />
                </label>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="border-line flex flex-col gap-3 border-t px-4 py-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted">De dónde sacaste estas fechas (opcional)</span>
          <input
            type="text"
            value={notaActual}
            onChange={(e) => setNota(e.target.value)}
            placeholder="Calendario académico 2026-2027, página 3"
            className="border-line bg-bg rounded-[var(--radius)] border px-2 py-1.5 text-sm"
          />
        </label>

        {invertida && (
          <p className="text-closed text-xs">
            En {titulo(invertida.event).toLowerCase()} la fecha de cierre es anterior a la de apertura.
          </p>
        )}
        {guardar.error && <p className="text-closed text-sm">No se pudo guardar: {guardar.error.message}</p>}
        {guardar.isSuccess && !tocado && (
          <p className="text-open text-xs">Calendario guardado. La etapa de arriba ya se recalculó con estas fechas.</p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => guardar.mutate()}
            disabled={!tocado || guardar.isPending || invertida !== undefined}
            className="bg-accent text-accent-fg rounded-[var(--radius)] px-3 py-2 text-sm font-medium disabled:opacity-40"
          >
            {guardar.isPending ? 'Guardando…' : 'Guardar calendario'}
          </button>
          {tocado && (
            <button
              type="button"
              onClick={() => {
                setEditadas(null);
                setNota(null);
              }}
              className="text-muted hover:text-fg text-xs"
            >
              Descartar cambios
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

// ── La pantalla ─────────────────────────────────────────────────────────────

export function Ciclo() {
  const hoy = new Date();
  const hoyNum = dayOf(hoy);

  // El switcher existe porque /api/term-phase sin ciclo responde por el que
  // corre hoy, y cargar el calendario del ciclo que viene (que es cuando más
  // falta hace) sería imposible sin poder pedirlo por nombre.
  const termsQ = useQuery({ queryKey: ['term-context'], queryFn: fetchTermContext });
  const opciones = [...(termsQ.data?.terms ?? [])].reverse();
  const [elegido, setElegido] = useState<string | null>(null);

  const { data: phase, isPending, error } = useQuery({
    queryKey: ['term-phase', elegido],
    queryFn: () => fetchTermPhase(elegido ?? undefined),
  });

  if (isPending) {
    return (
      <div className="border-line text-muted grid h-64 place-items-center rounded-[var(--radius)] border text-sm">
        Cargando…
      </div>
    );
  }
  if (error) return <p className="text-closed text-sm">No se pudo leer la etapa del ciclo: {error.message}</p>;

  const linea = lineaDelCiclo(phase, hoyNum);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-baseline gap-2">
            <h1 className="font-display text-2xl font-semibold tracking-tight">El ciclo</h1>
            <TermBadge label={phase.termLabel} />
          </div>
          <p className="text-muted mt-1 text-sm">En qué etapa estás y qué se puede hacer en ella.</p>
        </div>

        {opciones.length > 1 && (
          <label className="text-muted flex items-center gap-1.5 text-xs">
            Ciclo
            <select
              value={elegido ?? phase.term ?? ''}
              onChange={(e) => setElegido(e.target.value)}
              className="border-line bg-bg text-fg rounded-[var(--radius)] border px-2 py-1 text-xs"
            >
              {opciones.map((t) => (
                <option key={t.term} value={t.term}>
                  {t.label ?? t.term}
                  {t.isCurrent ? ' · actual' : t.isNext ? ' · próximo' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      {/* Dónde estás hoy. */}
      <section className="border-line bg-surface rounded-[var(--radius)] border p-5">
        <p className="text-muted text-xs font-medium tracking-wide uppercase">Hoy, {fecha(hoyISO(hoy))}</p>
        <h2 className="font-display mt-1 text-3xl font-semibold tracking-tight">{PHASE_LABELS[phase.phase]}</h2>
        <FaseBadge phase={phase.phase} confidence={phase.confidence} className="mt-2" />

        <div className="mt-3 space-y-1 text-sm">
          {phase.since && <p>Empezó el {fecha(phase.since)}.</p>}
          {phase.until ? (
            <p>
              Termina el {fecha(phase.until)}
              {phase.daysLeft !== null && `, ${cuanto(phase.daysLeft)}`}.
            </p>
          ) : (
            <p className="text-muted">El calendario que mikampus conoce no dice cuándo termina esta etapa.</p>
          )}

          {phase.next ? (
            <p>
              Lo que sigue: {titulo(phase.next.event).toLowerCase()}, {cuanto(phase.next.daysUntil)} (
              {fecha(phase.next.startsOn)}).
            </p>
          ) : (
            <p className="text-muted">No hay ninguna etapa futura con fecha conocida.</p>
          )}

          {phase.confidence === 'desconocida' && (
            <p className="text-waitlist">
              Ninguna fecha conocida ubica este ciclo en el tiempo. Cargá abajo lo que diga el calendario académico y
              esta pantalla se completa sola.
            </p>
          )}

          {phase.missing.length > 0 && (
            <p className="text-waitlist">
              {phase.missing.length === 1
                ? `Falta la fecha de ${TERM_EVENT_LABELS[phase.missing[0]]}.`
                : `Faltan ${phase.missing.length} fechas del ciclo.`}{' '}
              Mientras no estén, mikampus avisa pero no apaga nada por ellas.
            </p>
          )}
        </div>
      </section>

      {/* La línea del ciclo. En el orden en que las etapas ocurren y no por
          fecha: así una etapa sin fecha conserva su lugar en vez de caer al
          final como si no existiera. */}
      <section className="border-line bg-surface rounded-[var(--radius)] border">
        <header className="border-line border-b px-4 py-3">
          <h2 className="text-sm font-medium">Las etapas del ciclo</h2>
        </header>
        <ol className="divide-line divide-y">
          {linea.map((ventana) => {
            const { Icono, texto, clase } = ESTADOS[ventana.estado];
            const origen = procedencia(ventana.sources);
            return (
              <li key={ventana.event} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
                {/* Ancho fijo para que los nombres de las etapas queden en una
                    columna y la lista se lea de un vistazo. */}
                <span className={`inline-flex w-24 shrink-0 items-center gap-1.5 text-xs ${clase}`}>
                  <Icono className="size-3.5 shrink-0" aria-hidden />
                  {texto}
                </span>
                <p className="text-sm font-medium">{titulo(ventana.event)}</p>
                <div className="ml-auto text-right">
                  <p className={`text-xs ${ventana.estado === 'desconocida' ? 'text-waitlist' : 'text-muted'}`}>
                    {rango(ventana)}
                  </p>
                  {origen && <p className="text-muted text-xs">{origen}</p>}
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      {/* Qué podés hacer. */}
      <section className="border-line bg-surface rounded-[var(--radius)] border">
        <header className="border-line border-b px-4 py-3">
          <h2 className="text-sm font-medium">Lo que depende de la etapa</h2>
          <p className="text-muted mt-1 text-xs">
            Cada cosa apagada dice por qué y, si se sabe, cuándo vuelve. Lo que mikampus no sabe advierte, nunca apaga.
          </p>
        </header>
        <ul className="divide-line divide-y">
          {GATED_CAPABILITY_IDS.map((id) => (
            <FilaCapacidad key={id} id={id} phase={phase} />
          ))}
        </ul>
        <div className="border-line border-t px-4 py-3">
          <p className="text-muted text-xs">Esto no lo apaga ninguna fecha, ni con el ciclo cerrado:</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {ALWAYS_ON_CAPABILITY_IDS.map((id) => {
              const { label, donde } = CAPACIDADES[id];
              return donde ? (
                <Link
                  key={id}
                  to={donde}
                  className="border-line hover:bg-surface-2 inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs"
                >
                  {label}
                  <ArrowRight className="size-3" aria-hidden />
                </Link>
              ) : null;
            })}
          </div>
        </div>
      </section>

      {phase.term ? (
        <CalendarioAMano phase={phase} term={phase.term} queryKey={['term-phase', elegido]} />
      ) : (
        <section className="border-line bg-surface rounded-[var(--radius)] border p-5 text-sm">
          <h2 className="text-sm font-medium">Cargar una fecha del calendario académico</h2>
          <p className="text-muted mt-1">
            mikampus todavía no sabe qué ciclo corre, así que no hay a dónde guardar una fecha.
          </p>
          <Link to="/horario" className="text-accent mt-2 inline-flex items-center gap-1 underline underline-offset-2">
            Traer tu horario del portal
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </section>
      )}
    </div>
  );
}
