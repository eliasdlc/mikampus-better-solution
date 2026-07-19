import { useSearchParams } from 'react-router-dom';
import type { ReactNode } from 'react';
import { CalendarRange, Rows3, type LucideIcon } from 'lucide-react';
import { Planner } from './Planner.tsx';
import { Builder } from './Builder.tsx';

type Tab = 'materias' | 'horario';

// Planear reúne dos decisiones consecutivas sobre un mismo objeto: primero
// qué cursar y después qué grupo cabe. El id en la URL conserva ese contexto
// al cambiar de pestaña, recargar o compartir el enlace.
export function Planear() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'horario' ? 'horario' : 'materias';
  const parsedPlanId = Number(params.get('plan'));
  const activePlanId = Number.isSafeInteger(parsedPlanId) && parsedPlanId > 0 ? parsedPlanId : null;

  const setTab = (nextTab: Tab) => {
    const next = new URLSearchParams(params);
    if (nextTab === 'materias') next.delete('tab');
    else next.set('tab', nextTab);
    setParams(next, { replace: true });
  };

  const setActivePlan = (planId: number | null) => {
    const next = new URLSearchParams(params);
    if (planId == null) next.delete('plan');
    else next.set('plan', String(planId));
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Planear</h1>
        <p className="text-muted mt-1 text-sm">Armá un plan y después encontrá el horario que mejor le queda.</p>
      </header>

      <div className="border-line flex w-full gap-1 rounded-[var(--radius)] border p-1 sm:w-fit" role="tablist" aria-label="Vistas del plan">
        <TabButton active={tab === 'materias'} icon={Rows3} onClick={() => setTab('materias')}>
          Materias
        </TabButton>
        <TabButton active={tab === 'horario'} icon={CalendarRange} onClick={() => setTab('horario')}>
          Horario
        </TabButton>
      </div>

      {tab === 'materias' ? (
        <Planner activePlanId={activePlanId} onActivePlanChange={setActivePlan} embedded />
      ) : (
        <Builder activePlanId={activePlanId} onActivePlanChange={setActivePlan} embedded />
      )}
    </div>
  );
}

function TabButton({
  active,
  icon: Icon,
  onClick,
  children,
}: {
  active: boolean;
  icon: LucideIcon;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex min-h-9 items-center gap-2 rounded-[calc(var(--radius)-2px)] px-3 py-1.5 text-sm transition-colors duration-100 ${
        active ? 'bg-accent text-accent-fg font-medium' : 'text-muted hover:bg-surface-2 hover:text-fg'
      }`}
    >
      <Icon className="size-4" aria-hidden />
      {children}
    </button>
  );
}
