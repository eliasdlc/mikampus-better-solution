import { useQuery } from '@tanstack/react-query';
import { fetchStatus, type AgentStatus } from '../lib/api.ts';
import { ago } from '../lib/time.ts';

// El estado siempre visible (Fase 4 §3). No es un badge decorativo: responde
// "¿mikampus está trabajando para mí ahora?" y, cuando la respuesta es sí, dice
// qué necesita para seguir haciéndolo — equipo despierto, credencial vigente,
// agente vivo. Un watcher que se muestra activo con el agente caído es una
// promesa falsa que cuesta un cupo.

// Exportado: el estado del watcher se nombra igual en la barra superior y en la
// tarjeta de /inscripcion. Dos mapas separados terminan siempre en que una
// pantalla dice "en pausa" y la otra "credentials-required" sobre el mismo dato.
export const WATCHER_LABEL: Record<string, string> = {
  running: 'vigilando',
  paused: 'en pausa',
  offline: 'sin conexión',
  'credentials-required': 'necesita tu contraseña',
  'backing-off': 'esperando tras fallos',
  stopped: 'detenido',
  'monitoring-gap': 'con intervalo no vigilado',
};

export function useAgentStatus() {
  // Un minuto: el estado lee el almacén de credenciales del sistema, y no vale
  // la pena tocarlo cada pocos segundos para refrescar un texto.
  return useQuery({ queryKey: ['agent-status'], queryFn: fetchStatus, refetchInterval: 60_000 });
}

function humanGap(ms: number) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} días`;
}

export function AgentStatusBar() {
  const status = useAgentStatus();
  const data = status.data;
  if (!data) return null;

  const watcher = data.watcher;
  const active = watcher != null && ['running', 'backing-off', 'monitoring-gap'].includes(watcher.status);

  return (
    <div className="border-line bg-surface-2 text-muted flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-1.5 text-xs print:hidden">
      <span className="flex items-center gap-1.5">
        <span className={`size-2 rounded-full ${data.agent.running ? 'bg-open' : 'bg-closed'}`} />
        {data.agent.running ? `agente activo${data.agent.pid ? ` (PID ${data.agent.pid})` : ''}` : 'agente detenido'}
      </span>

      <span>
        watcher: {watcher ? (WATCHER_LABEL[watcher.status] ?? watcher.status) : 'apagado'}
        {watcher?.lastCheckAt ? ` · último check ${ago(watcher.lastCheckAt)}` : ''}
        {watcher && watcher.consecutiveFailures > 0 ? ` · ${watcher.consecutiveFailures} fallo(s) seguidos` : ''}
      </span>

      {data.monitoringGap && (
        <span className="text-closed">
          intervalo no vigilado de {humanGap(data.monitoringGap.ms)}: no se puede reconstruir un cupo que abrió y cerró ahí
        </span>
      )}

      {data.credential && (
        <span>credencial guardada hasta {new Date(data.credential.expiresAt).toLocaleDateString('es-DO')}</span>
      )}

      {data.power.mustStayAwake && (
        <span className="text-fg" title={data.power.note}>
          {active ? 'este equipo tiene que seguir encendido y despierto' : 'hay trabajo programado: no apagues el equipo'}
        </span>
      )}
    </div>
  );
}

// La versión larga, para Ajustes: lo mismo más la próxima acción y las copias.
export function AgentStatusDetail({ status }: { status: AgentStatus }) {
  const rows: Array<[string, string]> = [
    ['Modo', status.mode === 'desktop' ? 'Local Desktop' : 'Home Server'],
    ['Versión', status.agent.version],
    ['Esquema de datos', `versión ${status.schema.version}`],
    ['Agente', status.agent.running ? `activo desde ${status.agent.startedAt ? ago(status.agent.startedAt) : 'hace poco'}` : 'detenido'],
    [
      'Watcher',
      status.watcher
        ? `${WATCHER_LABEL[status.watcher.status] ?? status.watcher.status}${status.watcher.pauseReason ? ` — ${status.watcher.pauseReason}` : ''}`
        : 'apagado',
    ],
    ['Próxima consulta', status.watcher?.nextCheckAt ? new Date(status.watcher.nextCheckAt).toLocaleString('es-DO') : '—'],
    [
      'Disparo programado',
      status.schedule ? `${new Date(status.schedule.atISO).toLocaleString('es-DO')} (${status.schedule.state})` : 'ninguno',
    ],
    [
      'Credencial desatendida',
      status.credential
        ? `${status.credential.reason ?? 'función programada'} · vence ${new Date(status.credential.expiresAt).toLocaleDateString('es-DO')}`
        : 'ninguna guardada',
    ],
    [
      'Última copia',
      status.backup.lastSuccessfulAt ? ago(status.backup.lastSuccessfulAt) : 'todavía no hay copia verificada',
    ],
    ['Energía', status.power.note],
  ];

  return (
    <dl className="border-line divide-line mt-3 divide-y border-t text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5">
          <dt>{label}</dt>
          <dd className="text-muted text-xs">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
