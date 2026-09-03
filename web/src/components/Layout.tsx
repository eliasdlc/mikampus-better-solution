import { useEffect, useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import {
  CalendarDays,
  ChartLine,
  GraduationCap,
  House,
  Search,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { useSSE } from '../lib/sse.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import { AgentStatusBar } from './AgentStatus.tsx';
import { SyncControl } from './SyncControl.tsx';

// La navegación nombra las tareas, no las pantallas que el proyecto fue
// acumulando. Buscar, holds y elegir grupos siguen existiendo donde se usan.
//
// Decidir qué cursar el próximo ciclo llegó a tener TRES destinos hermanos:
// "Armar el ciclo", "Inscripción" y "El ciclo". En el teléfono salían pegados y
// no había forma de saber cuál tocaba primero; peor, hablaban de ciclos
// distintos entre sí. Ahora es uno solo con tres pasos, y la etapa del ciclo se
// consulta desde Inicio y desde el propio recorrido, que es donde importa.
const NAV: Array<{ to: string; label: string; short: string; icon: LucideIcon; end?: boolean }> = [
  { to: '/', label: 'Inicio', short: 'Inicio', icon: House, end: true },
  { to: '/horario', label: 'Mi horario', short: 'Horario', icon: CalendarDays },
  { to: '/inscripcion', label: 'Inscripción', short: 'Inscribir', icon: GraduationCap },
  { to: '/academico', label: 'Notas y avance', short: 'Notas', icon: ChartLine },
  { to: '/ajustes', label: 'Ajustes', short: 'Ajustes', icon: Settings },
];

function SidebarItem({ to, label, icon: Icon, end }: { to: string; label: string; icon: LucideIcon; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `tap flex items-center gap-2 rounded-[var(--radius)] px-3 py-2 text-sm transition-colors duration-100 ${
          isActive ? 'bg-accent text-accent-fg font-medium' : 'text-muted hover:bg-surface-2 hover:text-fg'
        }`
      }
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {label}
    </NavLink>
  );
}

// La barra inferior es lo que separa "una web abierta en el teléfono" de "una
// app". Los cinco destinos quedan bajo el pulgar, siempre visibles, y no se van
// con el scroll. Antes la navegación era una fila que envolvía arriba: se
// perdía al bajar y obligaba a estirar el dedo hasta el borde superior.
function TabBarItem({ to, short, icon: Icon, end }: { to: string; short: string; icon: LucideIcon; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `tap relative flex flex-1 flex-col items-center justify-center gap-0.5 px-1 pt-1.5 pb-1 text-[11px] transition-colors duration-100 ${
          isActive ? 'text-accent font-medium' : 'text-muted'
        }`
      }
    >
      {({ isActive }) => (
        <>
          {/* El indicador es una barra corta sobre el icono y no un fondo
              pintado: en una barra de cinco, cinco cápsulas compiten entre sí. */}
          <span
            className={`absolute top-0 h-0.5 w-8 rounded-full transition-opacity duration-100 ${
              isActive ? 'bg-accent opacity-100' : 'opacity-0'
            }`}
            aria-hidden
          />
          <Icon className="size-5 shrink-0" aria-hidden />
          <span className="leading-none">{short}</span>
        </>
      )}
    </NavLink>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { connected } = useSSE();
  const [paletteOpen, setPaletteOpen] = useState(false);

  // El refresh al montar murió con P1. Montar una pantalla no es una razón para
  // salir al portal, y hacerlo desde acá creaba una segunda política de
  // frescura que competía con la del backend. Ahora el tick del agente decide
  // qué está vencido y el control global es el gesto explícito.

  // El atajo se escucha en la ventana y no en un componente: ⌘K es global
  // (plan §5.2), tiene que abrir estés donde estés. Ctrl+K para el mismo gesto
  // en Linux/Windows.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // minmax(0,1fr) y no 1fr: un track 1fr no baja de su contenido mínimo, así
  // que el WeeklyGrid (que es ancho a propósito y scrollea solo) empujaba la
  // columna y desbordaba la página entera en tablet.
  return (
    <div className="app-shell min-h-full md:grid md:grid-cols-[220px_minmax(0,1fr)]">
      {/* ── Teléfono: barra superior compacta ──────────────────────────────
          Solo la marca y los controles de estado; los destinos viven abajo,
          bajo el pulgar. Sticky para que el contexto no se pierda al bajar por
          una lista larga. */}
      <header
        className="border-line bg-surface/95 sticky top-0 z-30 flex items-center justify-between gap-3 border-b px-4 backdrop-blur print:hidden md:hidden"
        style={{ paddingTop: 'calc(0.625rem + var(--safe-top))', paddingBottom: '0.625rem' }}
      >
        <span className="font-display text-lg font-semibold tracking-tight">mikampus</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label="Buscar"
            className="tap text-muted hover:text-fg flex items-center justify-center rounded-[var(--radius)]"
          >
            <Search className="size-5" aria-hidden />
          </button>
          <ThemeToggle />
        </div>
      </header>

      {/* ── Desktop: la barra lateral de siempre ───────────────────────────
          print:hidden — la navegación no existe en papel (plan §5.5).

          sticky + self-start: la barra medía una pantalla de alto, pero como
          era una celda normal del grid se iba con el scroll de la página, y en
          Notas o en el carrito largo la navegación desaparecía justo cuando
          hacía falta. `self-start` es obligatorio: sin él el grid estira la
          celda a todo el alto de la fila y sticky no tiene contra qué pegarse.
          El overflow propio es para el caso de una pantalla baja, donde el
          contenido de la barra no entra en 100vh. */}
      <aside className="border-line bg-surface hidden print:hidden md:sticky md:top-0 md:flex md:h-screen md:self-start md:overflow-y-auto md:flex-col md:items-stretch md:border-r md:px-4 md:py-5">
        <div className="mb-4 flex items-center gap-2">
          <span className="font-display text-lg font-semibold tracking-tight">mikampus</span>
        </div>

        {/* El atajo no se descubre solo: el botón es la misma puerta. */}
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="border-line text-muted hover:bg-surface-2 hover:text-fg tap mb-6 flex w-full items-center justify-between gap-2 rounded-[var(--radius)] border px-3 text-sm transition-colors duration-100"
        >
          <span className="flex items-center gap-2">
            <Search className="size-4" aria-hidden />
            Buscar…
          </span>
          <kbd className="border-line bg-surface-2 tabular rounded border px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
        </button>

        <nav className="flex flex-col gap-0.5" aria-label="Secciones">
          {NAV.map((item) => (
            <SidebarItem key={item.to} {...item} />
          ))}
        </nav>

        <div className="mt-auto flex w-full flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted flex items-center gap-1.5 text-xs" title="Conexión de actividad en vivo">
              <span className={`size-2 rounded-full ${connected ? 'bg-open' : 'bg-closed'}`} />
              {connected ? 'en vivo' : 'sin conexión'}
            </span>
            <ThemeToggle />
          </div>
          <SyncControl />
        </div>
      </aside>

      <div className="min-w-0">
        <AgentStatusBar />
        <main className="mx-auto w-full max-w-5xl px-4 py-5 print:max-w-none print:p-0 md:px-8 md:py-8">
          {children}
        </main>

        {/* El control de sincronización vive en el sidebar en desktop; en
            teléfono va al final del contenido, donde no compite con la
            navegación por el mismo espacio del pulgar. */}
        {/* Este bloque además reserva el alto de la barra: sin él, el último
            elemento de una lista larga queda tapado por la navegación. */}
        <div
          className="mx-auto w-full max-w-5xl px-4 print:hidden md:hidden"
          style={{ paddingBottom: 'calc(1rem + var(--tabbar-h))' }}
        >
          <SyncControl />
        </div>
      </div>

      {/* ── Teléfono: la barra de destinos ─────────────────────────────── */}
      <nav
        aria-label="Secciones"
        className="border-line bg-surface/95 fixed inset-x-0 bottom-0 z-30 flex border-t backdrop-blur print:hidden md:hidden"
        style={{ paddingBottom: 'var(--safe-bottom)' }}
      >
        {NAV.map((item) => (
          <TabBarItem key={item.to} {...item} />
        ))}
      </nav>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
