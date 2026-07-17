import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchCart, fetchState, fetchMySchedule, fetchHolds, fetchPlans } from '../lib/api.ts';
import { toBlocks, type Block } from '../lib/grid.ts';
import { agendaFor, nextClass, type NextClass } from '../../../src/shared/agenda.ts';
import { DAY_LABELS, toMinutes } from '../../../src/shared/meetings.ts';
import { courseColor } from '../lib/color.ts';
import { ago } from '../lib/time.ts';
import { Countdown } from '../components/Countdown.tsx';
import { ActivityFeed } from '../components/ActivityFeed.tsx';

// Dashboard (plan §5.1): el estado del día en una pantalla. Solo lo accionable
// hoy — ninguna gráfica decorativa. Todo sale de cache local, así que abre al
// instante y no toca el portal.

export function Dashboard() {
  const schedule = useQuery({ queryKey: ['my-schedule'], queryFn: () => fetchMySchedule() });
  const cart = useQuery({ queryKey: ['cart'], queryFn: fetchCart });
  const state = useQuery({ queryKey: ['state'], queryFn: fetchState });
  const holds = useQuery({ queryKey: ['holds'], queryFn: fetchHolds });
  const plans = useQuery({ queryKey: ['plans'], queryFn: fetchPlans });

  // Cada 30s: es lo que tarda "faltan 12 min" en volverse mentira. El countdown
  // del hero corre por su cuenta cada segundo; esto solo decide CUÁL es la
  // próxima clase y qué parte del día ya pasó.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // Solo lo inscrito ocupa tiempo: una materia dada de baja no es una clase a
  // la que tengas que ir.
  const blocks = useMemo(
    () => toBlocks((schedule.data?.courses ?? []).filter((c) => c.status === 'enrolled')),
    [schedule.data]
  );
  const proxima = useMemo(() => nextClass(blocks, now), [blocks, now]);
  const hoy = useMemo(() => agendaFor(blocks, now), [blocks, now]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-display text-3xl font-semibold tracking-tight">mikampus</h1>
        <p className="text-muted text-sm">
          {now.toLocaleDateString('es-DO', { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6">
          <Hero proxima={proxima} now={now} tieneHorario={blocks.length > 0} planes={plans.data?.length ?? 0} />

          <section>
            <h2 className="text-muted mb-2 text-xs font-medium tracking-wide uppercase">Hoy</h2>
            <Timeline blocks={hoy} now={now} />
          </section>
        </div>

        <aside className="space-y-3">
          <CartCard count={cart.data?.rows.length ?? 0} scheduledAt={state.data?.schedule?.atISO ?? null} />
          <WatcherCard watcher={state.data?.watcher ?? null} />
          <HoldsCard holds={holds.data?.holds ?? []} />
        </aside>
      </div>

      <CollapsibleFeed />
    </div>
  );
}

// El hero (plan §5.1): la próxima clase sobre una franja de su color, con el
// nombre grande y los minutos que faltan. Sin horario, invita a planificar en
// vez de mostrar un hueco.
function Hero({
  proxima,
  now,
  tieneHorario,
  planes,
}: {
  proxima: NextClass<Block> | null;
  now: Date;
  tieneHorario: boolean;
  planes: number;
}) {
  if (!proxima) {
    return (
      <section className="border-line rounded-[var(--radius)] border border-dashed p-6">
        <p className="font-display text-xl font-semibold tracking-tight">
          {tieneHorario ? 'Ninguna de tus materias tiene horario asignado' : 'Todavía no tenés horario inscrito'}
        </p>
        <p className="text-muted mt-1 text-sm">
          {planes > 0
            ? `Tenés ${planes} ${planes === 1 ? 'plan armado' : 'planes armados'}: elegí grupos y mandalos al carrito.`
            : 'Armá tu ciclo en el planner y mandá las materias al carrito antes de la hora de inscripción.'}
        </p>
        <Link
          to={planes > 0 ? '/planner' : '/buscar'}
          className="bg-accent text-accent-fg mt-4 inline-block rounded-[var(--radius)] px-3 py-2 text-sm font-medium"
        >
          {planes > 0 ? 'Ir al planner' : 'Buscar materias'}
        </Link>
      </section>
    );
  }

  const { block, at, ongoing } = proxima;
  const esHoy = at.toDateString() === now.toDateString();
  // En curso se cuenta hacia el final de la clase, no hacia su inicio: lo que
  // querés saber es cuánto te queda adentro.
  const hasta = ongoing ? new Date(at.getFullYear(), at.getMonth(), at.getDate()) : at;
  if (ongoing) hasta.setHours(...(block.end.split(':').map(Number) as [number, number]), 0, 0);

  return (
    <section className="border-line bg-surface overflow-hidden rounded-[var(--radius)] border">
      <div className="h-1.5" style={{ background: courseColor(block.code) }} aria-hidden />
      <div className="flex flex-wrap items-end justify-between gap-4 p-5">
        <div className="min-w-0">
          <p className="text-muted text-xs">
            {ongoing ? 'En curso' : esHoy ? 'Próxima clase, hoy' : `Próxima clase · ${DAY_LABELS[block.day]}`}
          </p>
          {/* Dos líneas y no truncate: en 390px "Seguridad Tecnologías
              Información" se cortaba en "Seguridad Tecnologí…" y el nombre de
              la materia es justo lo que el hero viene a decir. */}
          <h2 className="font-display mt-1 line-clamp-2 text-3xl font-semibold tracking-tight text-balance">
            {block.title}
          </h2>
          <p className="text-muted tabular mt-1 font-mono text-sm">
            {block.code} · {block.start}–{block.end} · {block.room ?? 'Aula por definir'}
            {block.instructor ? ` · ${block.instructor}` : ''}
          </p>
        </div>
        <div className="text-right">
          <Countdown toISO={hasta.toISOString()} />
          <p className="text-muted text-xs">{ongoing ? 'para que termine' : 'para que empiece'}</p>
        </div>
      </div>
    </section>
  );
}

// La agenda del día como timeline vertical. Lo que ya pasó queda apagado: el
// día se lee de un vistazo sabiendo en qué punto estás.
function Timeline({ blocks, now }: { blocks: Block[]; now: Date }) {
  if (!blocks.length) {
    return (
      <p className="border-line text-muted rounded-[var(--radius)] border border-dashed p-4 text-sm">
        Hoy no tenés clases.
      </p>
    );
  }

  const minutosAhora = now.getHours() * 60 + now.getMinutes();

  return (
    <ol className="border-line bg-surface divide-line divide-y rounded-[var(--radius)] border">
      {blocks.map((block) => {
        const pasada = toMinutes(block.end) <= minutosAhora;
        const enCurso = !pasada && toMinutes(block.start) <= minutosAhora;
        return (
          <li key={block.id} className={`flex items-center gap-3 px-4 py-3 ${pasada ? 'opacity-45' : ''}`}>
            <div className="tabular w-14 shrink-0 font-mono text-xs">
              <div>{block.start}</div>
              <div className="text-muted">{block.end}</div>
            </div>
            <span
              className="h-9 w-1 shrink-0 rounded-full"
              style={{ background: courseColor(block.code) }}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{block.title}</div>
              <div className="text-muted tabular font-mono text-xs">
                {block.code} · {block.room ?? 'Aula por definir'}
              </div>
            </div>
            {enCurso && <span className="text-open text-xs font-medium whitespace-nowrap">en curso</span>}
          </li>
        );
      })}
    </ol>
  );
}

function Card({ to, title, children }: { to: string; title: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="border-line bg-surface hover:bg-surface-2 block rounded-[var(--radius)] border p-4 transition-colors duration-100"
    >
      <div className="text-muted text-xs">{title}</div>
      {children}
    </Link>
  );
}

function CartCard({ count, scheduledAt }: { count: number; scheduledAt: string | null }) {
  return (
    <Card to="/inscripcion" title="Carrito">
      <div className="font-display tabular mt-1 text-2xl font-semibold">{count}</div>
      <div className="text-muted text-xs">{count === 1 ? 'materia lista' : 'materias listas'} para inscribir</div>
      {scheduledAt ? (
        <div className="border-line mt-3 border-t pt-3">
          <Countdown toISO={scheduledAt} size="sm" />
          <div className="text-muted mt-0.5 text-xs">para el disparo automático</div>
        </div>
      ) : (
        <div className="text-muted border-line mt-3 border-t pt-3 text-xs">Sin disparo programado</div>
      )}
    </Card>
  );
}

function WatcherCard({ watcher }: { watcher: { intervalMs: number; lastCheckAt: string | null } | null }) {
  return (
    <Card to="/inscripcion" title="Watcher de cupos">
      <div className="mt-1 flex items-center gap-2 text-lg font-medium">
        <span className={`size-2.5 rounded-full ${watcher ? 'bg-open' : 'bg-muted'}`} />
        {watcher ? 'Activo' : 'Apagado'}
      </div>
      <div className="text-muted mt-1 text-xs">
        {!watcher
          ? 'no está vigilando el carrito'
          : watcher.lastCheckAt
            ? // "activo" y "activo y mirando" no son lo mismo: un watcher que
              // no chequea hace media hora está roto y hay que poder verlo.
              `cada ${Math.round(watcher.intervalMs / 1000)}s · último check ${ago(watcher.lastCheckAt)}`
            : `cada ${Math.round(watcher.intervalMs / 1000)}s · sin chequear todavía`}
      </div>
    </Card>
  );
}

// Rojo solo si hay (plan §5.1): un badge de alerta permanente no alerta de nada.
function HoldsCard({ holds }: { holds: { title: string; severity: string }[] }) {
  const bloqueantes = holds.filter((h) => h.severity === 'blocking').length;
  return (
    <Card to="/holds" title="Holds">
      {holds.length === 0 ? (
        <>
          <div className="mt-1 text-lg font-medium">Ninguno</div>
          <div className="text-muted mt-1 text-xs">nada te bloquea la inscripción</div>
        </>
      ) : (
        <>
          <div className={`font-display tabular mt-1 text-2xl font-semibold ${bloqueantes ? 'text-closed' : ''}`}>
            {holds.length}
          </div>
          <div className="text-muted mt-1 text-xs">
            {/* El portal no dice qué bloquea (ver el recon de Fase 4): 'unknown'
                no es "no bloquea", y la app no lo traduce a tranquilidad. */}
            {bloqueantes > 0 ? `${bloqueantes} bloquea(n) la inscripción` : 'revisá si bloquean la inscripción'}
          </div>
        </>
      )}
    </Card>
  );
}

// El feed al pie, colapsable y cerrado por defecto: es contexto, no es lo que
// venís a hacer al Dashboard.
function CollapsibleFeed() {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-muted hover:text-fg flex items-center gap-1.5 text-xs"
      >
        <span aria-hidden>{open ? '▾' : '▸'}</span> Actividad
      </button>
      {open && (
        <div className="mt-2">
          <ActivityFeed />
        </div>
      )}
    </section>
  );
}
