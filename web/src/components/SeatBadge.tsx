import type { SeatStatus } from '../../../src/shared/schemas.ts';

const LABEL: Record<SeatStatus, string> = { open: 'Abierta', waitlist: 'Lista de espera', closed: 'Llena' };
const CLS: Record<SeatStatus, string> = {
  open: 'text-open border-open/40 bg-open/10',
  waitlist: 'text-waitlist border-waitlist/40 bg-waitlist/10',
  closed: 'text-closed border-closed/40 bg-closed/10',
};

export function SeatBadge({ status, open, capacity }: { status: SeatStatus; open?: number | null; capacity?: number | null }) {
  const counts = open != null && capacity != null ? ` ${open}/${capacity}` : '';
  return (
    <span className={`tabular inline-flex items-center rounded-[var(--radius)] border px-1.5 py-0.5 text-xs font-medium ${CLS[status]}`}>
      {LABEL[status]}
      {counts && <span className="ml-1 font-mono opacity-80">{counts}</span>}
    </span>
  );
}
