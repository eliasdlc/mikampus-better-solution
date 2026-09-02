import { CalendarCheck, CalendarClock, CircleHelp, type LucideIcon } from 'lucide-react';
import type { PhaseId } from '../../../src/shared/termPhase.ts';
import type { TermPhaseResponse } from '../../../src/shared/schemas.ts';

// El nombre de la etapa del ciclo, siempre acompañado de DE DÓNDE salió.
//
// La confianza va pegada al nombre y no en una línea aparte porque el modo de
// fallar de esta pantalla es presentar una etapa deducida con la misma cara que
// una fechada. "Docencia" inferida de las fechas del ciclo y "Inscripción"
// leída del calendario no valen lo mismo, y quien mira tiene que poder
// distinguirlas sin buscar la letra chica.

export const PHASE_LABELS = {
  'pre-inscripcion': 'Antes de inscribir',
  'inscripcion-regular': 'Inscripción',
  'modificacion-inscripcion': 'Modificación de inscripción',
  'inscripcion-tardia': 'Inscripción tardía',
  docencia: 'Docencia',
  'retiro-parcial': 'Retiro parcial',
  'retiro-total': 'Retiro total',
  notas: 'Publicación de notas',
  'ciclo-cerrado': 'Ciclo cerrado',
  desconocida: 'Etapa desconocida',
} as const satisfies Record<PhaseId, string>;

type Confianza = TermPhaseResponse['confidence'];

const CONFIANZA = {
  fechada: { Icono: CalendarCheck, texto: 'por una fecha del calendario' },
  inferida: { Icono: CalendarClock, texto: 'deducida de las fechas del ciclo' },
  desconocida: { Icono: CircleHelp, texto: 'sin ninguna fecha que lo diga' },
} as const satisfies Record<Confianza, { Icono: LucideIcon; texto: string }>;

export function FaseBadge({
  phase,
  confidence,
  className = '',
}: {
  phase: PhaseId;
  confidence: Confianza;
  className?: string;
}) {
  const { Icono, texto } = CONFIANZA[confidence];
  return (
    <span
      className={`border-line inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${className}`}
    >
      <Icono className="size-3.5 shrink-0" aria-hidden />
      <span className="font-medium">{PHASE_LABELS[phase]}</span>
      <span className="text-muted">{texto}</span>
    </span>
  );
}
