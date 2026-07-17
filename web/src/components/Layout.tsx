import { useEffect, useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useSSE } from '../lib/sse.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';
import { CommandPalette } from './CommandPalette.tsx';

const NAV = [
  { to: '/', label: 'Inicio', end: true },
  { to: '/buscar', label: 'Buscar' },
  { to: '/planner', label: 'Planner' },
  { to: '/builder', label: 'Builder' },
  { to: '/horario', label: 'Mi horario' },
  { to: '/inscripcion', label: 'Inscripción' },
  { to: '/academico', label: 'Notas y avance' },
  { to: '/holds', label: 'Holds' },
  { to: '/ajustes', label: 'Ajustes' },
];

export function Layout({ children }: { children: ReactNode }) {
  const { connected } = useSSE();
  const [paletteOpen, setPaletteOpen] = useState(false);

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
      {/* En mobile esto es una barra superior. Con cuatro secciones el nav ya
          no entra al lado del logo en 390px, así que baja a su propia línea
          (order + w-full) en vez de desbordar la página a lo ancho. */}
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
          Buscar…
          <kbd className="border-line bg-surface-2 tabular rounded border px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
        </button>

        {/* flex-wrap: con seis secciones el nav ya no entra en una línea de
            390px; que baje de línea antes que desbordar la página. */}
        <nav className="order-3 flex w-full flex-wrap gap-1 md:order-none md:w-auto md:flex-col md:flex-nowrap">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `rounded-[var(--radius)] px-3 py-2 text-sm transition-colors duration-100 ${
                  isActive
                    ? 'bg-accent text-accent-fg font-medium'
                    : 'text-muted hover:bg-surface-2 hover:text-fg'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="order-2 flex items-center gap-3 md:order-none md:mt-auto md:justify-between">
          <span className="text-muted flex items-center gap-1.5 text-xs" title="Conexión de actividad en vivo">
            <span className={`size-2 rounded-full ${connected ? 'bg-open' : 'bg-closed'}`} />
            {connected ? 'en vivo' : 'sin conexión'}
          </span>
          <ThemeToggle />
        </div>
      </aside>

      <main className="mx-auto w-full max-w-5xl px-4 py-6 print:max-w-none print:p-0 md:px-8 md:py-8">{children}</main>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
