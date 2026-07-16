import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchCart, fetchState } from '../lib/api.ts';

export function Dashboard() {
  const cart = useQuery({ queryKey: ['cart'], queryFn: fetchCart });
  const state = useQuery({ queryKey: ['state'], queryFn: fetchState });

  const cartCount = cart.data?.length ?? 0;
  const scheduledAt = state.data?.schedule?.atISO;
  const watcherOn = !!state.data?.watcher;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tight">mikampus</h1>
        <p className="text-muted mt-1 text-sm">Tu centro de comando académico. Rápido, tuyo, sin micampus.</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <Link
          to="/inscripcion"
          className="border-line bg-surface hover:bg-surface-2 rounded-[var(--radius)] border p-4 transition-colors duration-100"
        >
          <div className="text-muted text-xs">Carrito</div>
          <div className="font-display tabular mt-1 text-2xl font-semibold">{cartCount}</div>
          <div className="text-muted mt-1 text-xs">materias listas para inscribir</div>
        </Link>

        <Link
          to="/inscripcion"
          className="border-line bg-surface hover:bg-surface-2 rounded-[var(--radius)] border p-4 transition-colors duration-100"
        >
          <div className="text-muted text-xs">Disparo programado</div>
          <div className="mt-1 text-lg font-medium">
            {scheduledAt ? new Date(scheduledAt).toLocaleString('es-DO') : '—'}
          </div>
          <div className="text-muted mt-1 text-xs">{scheduledAt ? 'inscripción automática' : 'sin programar'}</div>
        </Link>

        <Link
          to="/inscripcion"
          className="border-line bg-surface hover:bg-surface-2 rounded-[var(--radius)] border p-4 transition-colors duration-100"
        >
          <div className="text-muted text-xs">Watcher de cupos</div>
          <div className="mt-1 flex items-center gap-2 text-lg font-medium">
            <span className={`size-2.5 rounded-full ${watcherOn ? 'bg-open' : 'bg-muted'}`} />
            {watcherOn ? 'Activo' : 'Apagado'}
          </div>
          <div className="text-muted mt-1 text-xs">vigilando el carrito</div>
        </Link>
      </div>

      <Link
        to="/buscar"
        className="border-line bg-surface hover:bg-surface-2 flex items-center justify-between rounded-[var(--radius)] border p-4 transition-colors duration-100"
      >
        <span className="text-sm font-medium">Buscar materias</span>
        <span className="text-muted text-xs">nombre, código o profesor · instantáneo →</span>
      </Link>
    </div>
  );
}
