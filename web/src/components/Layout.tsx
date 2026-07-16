import { type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useSSE } from '../lib/sse.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';

const NAV = [
  { to: '/', label: 'Inicio', end: true },
  { to: '/buscar', label: 'Buscar' },
  { to: '/horario', label: 'Mi horario' },
  { to: '/inscripcion', label: 'Inscripción' },
];

export function Layout({ children }: { children: ReactNode }) {
  const { connected } = useSSE();

  // minmax(0,1fr) y no 1fr: un track 1fr no baja de su contenido mínimo, así
  // que el WeeklyGrid (que es ancho a propósito y scrollea solo) empujaba la
  // columna y desbordaba la página entera en tablet.
  return (
    <div className="min-h-full md:grid md:grid-cols-[220px_minmax(0,1fr)]">
      {/* En mobile esto es una barra superior. Con cuatro secciones el nav ya
          no entra al lado del logo en 390px, así que baja a su propia línea
          (order + w-full) en vez de desbordar la página a lo ancho. */}
      <aside className="border-line bg-surface flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b px-4 py-3 md:h-screen md:flex-nowrap md:flex-col md:items-stretch md:justify-start md:border-r md:border-b-0 md:px-4 md:py-5">
        <div className="flex items-center gap-2 md:mb-6">
          <span className="font-display text-lg font-semibold tracking-tight">mikampus</span>
        </div>

        <nav className="order-3 flex w-full gap-1 md:order-none md:w-auto md:flex-col">
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

      <main className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8 md:py-8">{children}</main>
    </div>
  );
}
