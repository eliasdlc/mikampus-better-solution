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
// Planear salió de la navegación primaria: planificar e inscribirse eran el
// mismo trabajo partido en dos, y mantenerlos separados obligaba a llevar dos
// contextos de ciclo en la cabeza. Ahora es la primera etapa de /inscripcion.
const NAV: Array<{ to: string; label: string; icon: LucideIcon; end?: boolean }> = [
  { to: '/', label: 'Inicio', icon: House, end: true },
  { to: '/horario', label: 'Mi horario', icon: CalendarDays },
  { to: '/inscripcion', label: 'Inscripción', icon: GraduationCap },
  { to: '/academico', label: 'Notas y avance', icon: ChartLine },
  { to: '/ajustes', label: 'Ajustes', icon: Settings },
];

function NavItem({ to, label, icon: Icon, end }: { to: string; label: string; icon: LucideIcon; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-2 rounded-[var(--radius)] px-3 py-2 text-sm transition-colors duration-100 ${
          isActive ? 'bg-accent text-accent-fg font-medium' : 'text-muted hover:bg-surface-2 hover:text-fg'
        }`
      }
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {label}
    </NavLink>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { connected } = useSSE();
  const [paletteOpen, setPaletteOpen] = useState(false);

  // El refresh al montar murió con P1. Montar una pantalla no es una razón para
  // salir al portal, y hacerlo desde acá creaba una segunda política de
  // frescura que competía con la del backend. Ahora el tick del agente decide
  // qué está vencido y el control global de abajo es el gesto explícito.

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
      {/* En mobile esto es una barra superior. El nav baja a su propia línea
          para que cada destino siga siendo tocable a 390px. */}
      {/* print:hidden — la navegación no existe en papel (plan §5.5). */}
      <aside className="border-line bg-surface flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b px-4 py-3 print:hidden md:h-screen md:flex-nowrap md:flex-col md:items-stretch md:justify-start md:border-r md:border-b-0 md:px-4 md:py-5">
        <div className="flex items-center gap-2 md:mb-4">
          <span className="font-display text-lg font-semibold tracking-tight">mikampus</span>
        </div>

        {/* El atajo no se descubre solo, y en mobile no hay ⌘K que apretar: el
            botón es la misma puerta, tocable. */}
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="border-line text-muted hover:bg-surface-2 hover:text-fg order-4 flex w-full items-center justify-between gap-2 rounded-[var(--radius)] border px-3 py-2 text-sm transition-colors duration-100 md:order-none md:mb-6"
        >
          <span className="flex items-center gap-2"><Search className="size-4" aria-hidden />Buscar…</span>
          <kbd className="border-line bg-surface-2 tabular rounded border px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
        </button>

        {/* En mobile puede envolver sin desbordar; en desktop es una columna. */}
        <nav className="order-3 flex w-full flex-wrap gap-1 md:order-none md:w-auto md:flex-col md:flex-nowrap md:gap-0">
          {NAV.map((item) => (
            <NavItem key={item.to} {...item} />
          ))}
        </nav>

        <div className="order-2 flex w-full flex-col gap-2 md:order-none md:mt-auto">
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
        <main className="mx-auto w-full max-w-5xl px-4 py-6 print:max-w-none print:p-0 md:px-8 md:py-8">{children}</main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
