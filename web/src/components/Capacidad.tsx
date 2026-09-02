import type { ReactNode } from 'react';
import { AlertTriangle, Lock } from 'lucide-react';
import type { CapabilityId, CapabilityState } from '../../../src/shared/termPhase.ts';
import type { TermPhaseResponse } from '../../../src/shared/schemas.ts';

// Cómo se ve en pantalla que la fase del ciclo apagó algo.
//
// La regla, y es la que hace que esto exista como componente y no como un
// `disabled` suelto en cada botón: un control apagado SIEMPRE dice por qué, y
// cuando se sabe, cuándo vuelve a abrir. Un botón gris sin explicación es una
// app que le hace adivinar al usuario si es un bug o una regla.
//
// La otra mitad de la regla vive en el backend (shared/termPhase.ts): una
// capacidad solo se apaga cuando hay una fecha real que lo diga. No saber
// advierte, nunca bloquea. Acá eso se traduce en que 'advertida' deja el
// control FUNCIONANDO y solo le pone un aviso al lado.

export function capabilityOf(phase: TermPhaseResponse | undefined, id: CapabilityId): CapabilityState {
  return phase?.capabilities?.[id] ?? { state: 'habilitada' };
}

export function isBlocked(state: CapabilityState): boolean {
  return state.state === 'cerrada';
}

/**
 * Envuelve un control. Si la capacidad está cerrada, lo deshabilita y muestra
 * el motivo debajo; si está advertida, lo deja andar y muestra el aviso.
 *
 * `children` recibe si tiene que estar deshabilitado, en vez de que este
 * componente lo clone: clonar un hijo para inyectarle props obliga a adivinar
 * qué prop es la correcta para cada tipo de control.
 */
export function Capacidad({
  state,
  children,
}: {
  state: CapabilityState;
  children: (blocked: boolean) => ReactNode;
}) {
  const blocked = isBlocked(state);
  return (
    <div className="flex flex-col gap-1">
      {children(blocked)}
      {state.state !== 'habilitada' && (
        <p
          className={`flex items-start gap-1.5 text-xs ${blocked ? 'text-closed' : 'text-waitlist'}`}
          role={blocked ? 'status' : undefined}
        >
          {blocked ? (
            <Lock className="mt-0.5 size-3 shrink-0" aria-hidden />
          ) : (
            <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
          )}
          <span>
            {state.reason}
            {state.state === 'cerrada' && state.reopensOn && ` Vuelve a abrir el ${state.reopensOn}.`}
          </span>
        </p>
      )}
    </div>
  );
}
