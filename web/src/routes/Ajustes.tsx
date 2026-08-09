import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  checkForUpdate,
  createBackupNow,
  createChannel,
  deleteAllMyData,
  exportBackupTo,
  exportDiagnosticsTo,
  fetchAccountOverview,
  fetchActions,
  fetchChannels,
  fetchDiagnostics,
  fetchErasePreview,
  runSync,
  fetchClassReminders,
  setClassReminders,
  removeChannel,
  setBackupRetention,
  setUpdatePolicy,
  testNotificationChannel,
  toggleChannel,
} from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { ThemeToggle } from '../components/ThemeToggle.tsx';
import { AgentStatusDetail, useAgentStatus } from '../components/AgentStatus.tsx';
import { enablePush, disablePush, getPushState } from '../lib/push.ts';
import { ago } from '../lib/time.ts';

const PERSONAL_QUERIES = ['cart', 'grades', 'holds', 'my-schedule', 'pensum', 'requirements', 'profile', 'plans', 'state'];

export function Ajustes() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { me, logout } = useAuth();
  const overview = useQuery({ queryKey: ['account-overview'], queryFn: fetchAccountOverview });
  const actions = useQuery({ queryKey: ['actions'], queryFn: fetchActions });
  const [confirmDelete, setConfirmDelete] = useState('');

  // Ajustes usa el MISMO orquestador que el control global: no existe una
  // segunda política de frescura escondida en una pantalla (P1, decisión 6).
  const refresh = useMutation({
    mutationFn: () => runSync({ force: true }),
    onSuccess: () => {
      for (const key of PERSONAL_QUERIES) queryClient.invalidateQueries({ queryKey: [key] });
      queryClient.invalidateQueries({ queryKey: ['account-overview'] });
      queryClient.invalidateQueries({ queryKey: ['sync'] });
    },
  });

  const erase = useMutation({
    mutationFn: deleteAllMyData,
    onSuccess: () => window.location.assign('/'),
  });

  const credential = overview.data?.credential;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Ajustes</h1>
          <p className="text-muted mt-1 text-sm">Tu cuenta, tus datos y lo que mikampus puede hacer por vos.</p>
        </div>
        <button
          type="button"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          className="border-line hover:bg-surface-2 rounded-[var(--radius)] border px-3 py-2 text-sm font-medium disabled:opacity-50"
        >
          {refresh.isPending ? 'Actualizando…' : 'Actualizar'}
        </button>
      </header>

      {refresh.isSuccess && (
        <p className="text-open text-sm">
          {refresh.data.results.filter((r) => r.status === 'updated').length
            ? `Actualicé ${refresh.data.results.filter((r) => r.status === 'updated').map((r) => r.label.toLowerCase()).join(', ')}.`
            : 'Todo lo personal sigue vigente; no hubo que consultar PeopleSoft.'}
        </p>
      )}
      {refresh.error && <p className="text-closed text-sm">No se pudo completar la actualización: {refresh.error.message}</p>}

      <section className="border-line bg-surface rounded-[var(--radius)] border p-5">
        <h2 className="text-sm font-medium">Cuenta</h2>
        <p className="text-muted mt-1 text-sm">
          Entraste como <span className="text-fg font-medium">{me?.user?.username ?? overview.data?.user?.portalUsername ?? 'tu cuenta PUCMM'}</span>.
        </p>
        <button
          type="button"
          onClick={async () => {
            await logout();
            navigate('/', { replace: true });
          }}
          className="border-line hover:bg-surface-2 mt-4 rounded-[var(--radius)] border px-3 py-2 text-sm font-medium"
        >
          Cerrar sesión
        </button>
      </section>

      <section className="border-line bg-surface rounded-[var(--radius)] border p-5">
        <h2 className="text-sm font-medium">Preferencias</h2>
        <div className="border-line mt-3 flex items-center justify-between gap-4 border-t pt-3">
          <div>
            <p className="text-sm">Tema</p>
            <p className="text-muted mt-1 text-xs">Elegí claro, oscuro o la preferencia de tu dispositivo.</p>
          </div>
          <ThemeToggle />
        </div>
      </section>

      <EstadoSection />

      <NotificacionesSection />
      <RecordatoriosSection />

      <CanalesSection />

      <CopiasSection />

      <DiagnosticosSection />

      <ActualizacionesSection />

      <section className="border-line bg-surface rounded-[var(--radius)] border p-5">
        <h2 className="text-sm font-medium">Historial</h2>
        <p className="text-muted mt-1 text-xs">Cada acción que mikampus hizo sobre tu matrícula y la respuesta literal del portal.</p>
        {!actions.data?.length ? (
          <p className="text-muted mt-4 text-sm">Todavía no hay acciones registradas.</p>
        ) : (
          <ol className="border-line mt-4 divide-line divide-y rounded-[var(--radius)] border">
            {actions.data.map((action) => (
              <li key={action.id} className="px-3 py-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="font-medium">{action.detail ?? action.action}</span>
                  <time className="text-muted text-xs" title={action.createdAt}>{ago(action.createdAt)}</time>
                </div>
                <p className={action.ok === false ? 'text-closed mt-1 text-xs' : 'text-muted mt-1 text-xs'}>
                  {action.portalResponse ?? 'El portal no confirmó el resultado.'}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="border-line bg-surface rounded-[var(--radius)] border p-5">
        <h2 className="text-sm font-medium">Tus datos</h2>
        <dl className="border-line mt-3 divide-line divide-y border-t text-sm">
          {overview.data?.syncs.map((sync) => (
            <div key={sync.kind} className="flex items-center justify-between gap-4 py-2.5">
              <dt>{sync.label}</dt>
              <dd className="text-muted text-xs">{sync.syncedAt ? ago(sync.syncedAt) : 'todavía no sincronizado'}</dd>
            </div>
          ))}
        </dl>
        <div className="border-line mt-4 border-t pt-4 text-sm">
          {credential ? (
            <p className="text-muted leading-6">
              Hay una credencial cifrada guardada para <span className="text-fg">{credential.reason ?? 'una función programada'}</span>. Se borra el{' '}
              <span className="text-fg">{new Date(credential.expiresAt).toLocaleDateString('es-DO', { dateStyle: 'long' })}</span>.
            </p>
          ) : (
            <p className="text-muted leading-6">No hay una contraseña guardada. Tu sesión actual vive solo en memoria.</p>
          )}
          <ErasePreview />
          <label className="mt-4 block space-y-1.5">
            <span className="text-muted text-xs">Escribí <span className="font-mono text-fg">BORRAR</span> para confirmar</span>
            <input value={confirmDelete} onChange={(e) => setConfirmDelete(e.target.value)} className="border-line bg-surface-2 focus:border-closed w-full rounded-[var(--radius)] border px-3 py-2 text-sm outline-none" />
          </label>
          <button
            type="button"
            onClick={() => erase.mutate({})}
            disabled={confirmDelete !== 'BORRAR' || erase.isPending}
            className="bg-closed mt-3 rounded-[var(--radius)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {erase.isPending ? 'Borrando…' : 'Borrar todos mis datos'}
          </button>
          {erase.error && <p className="text-closed mt-2 text-sm">No se pudieron borrar los datos: {erase.error.message}</p>}
        </div>
      </section>
    </div>
  );
}

// El estado permanente también vive acá en su versión larga: la barra superior
// contesta "¿está trabajando?" y esta tabla contesta "¿con qué y hasta cuándo?".
function EstadoSection() {
  const status = useAgentStatus();
  if (!status.data) return null;
  return (
    <section className="border-line bg-surface rounded-[var(--radius)] border p-5">
      <h2 className="text-sm font-medium">Estado de mikampus</h2>
      <AgentStatusDetail status={status.data} />
      {status.data.monitoringGap && (
        <p className="text-muted mt-3 text-xs leading-5">
          Hubo un intervalo sin vigilancia entre {new Date(status.data.monitoringGap.from).toLocaleString('es-DO')} y{' '}
          {new Date(status.data.monitoringGap.to).toLocaleString('es-DO')}. Si un cupo abrió y cerró ahí adentro, mikampus
          no puede reconstruirlo: al volver hace una consulta fresca, no repite los ticks perdidos.
        </p>
      )}
    </section>
  );
}

// Adaptadores externos (§5). Cada uno muestra a dónde va, qué manda y de qué
// depende ANTES de encenderse, y nace apagado: el contrato de egress se cumple
// mostrando el destino, no prometiéndolo.
function CanalesSection() {
  const queryClient = useQueryClient();
  const channels = useQuery({ queryKey: ['channels'], queryFn: fetchChannels });
  const [kind, setKind] = useState('ntfy');
  const [destination, setDestination] = useState('');
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['channels'] });

  const create = useMutation({ mutationFn: createChannel, onSuccess: () => { setDestination(''); invalidate(); } });
  const toggle = useMutation({ mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => toggleChannel(id, enabled), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: removeChannel, onSuccess: invalidate });
  const test = useMutation({ mutationFn: testNotificationChannel, onSuccess: invalidate });

  return (
    <section className="border-line bg-surface rounded-[var(--radius)] border p-5">
      <h2 className="text-sm font-medium">Avisos hacia afuera</h2>
      <p className="text-muted mt-1 text-xs leading-5">
        El feed local y las notificaciones del sistema no salen de este equipo. Estos adaptadores sí: cada mensaje viaja a
        un servicio que vos elegís. Nacen apagados y solo mandan título, texto corto y el enlace a localhost — nunca tu
        contraseña ni tus notas.
      </p>

      {channels.data?.channels.map((channel) => (
        <div key={channel.id} className="border-line mt-3 rounded-[var(--radius)] border p-3 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium">{channel.label}</span>
            <span className={channel.enabled ? 'text-open text-xs' : 'text-muted text-xs'}>
              {channel.enabled ? 'encendido' : 'apagado'}
            </span>
          </div>
          <p className="text-muted mt-1 font-mono text-xs break-all">{channel.destination}</p>
          <p className="text-muted mt-1 text-xs leading-5">Depende de: {channel.dependency}</p>
          <p className="text-muted mt-1 text-xs leading-5">
            Payload: <span className="font-mono">{JSON.stringify(channel.payloadSample)}</span>
          </p>
          {channel.lastError && <p className="text-closed mt-1 text-xs">Última falla: {channel.lastError}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => test.mutate(channel.id)} className="border-line hover:bg-surface-2 rounded-[var(--radius)] border px-2.5 py-1.5 text-xs">
              Probar
            </button>
            <button type="button" onClick={() => toggle.mutate({ id: channel.id, enabled: !channel.enabled })} className="border-line hover:bg-surface-2 rounded-[var(--radius)] border px-2.5 py-1.5 text-xs">
              {channel.enabled ? 'Apagar' : 'Encender'}
            </button>
            <button type="button" onClick={() => remove.mutate(channel.id)} className="text-closed hover:bg-surface-2 rounded-[var(--radius)] px-2.5 py-1.5 text-xs">
              Quitar
            </button>
          </div>
        </div>
      ))}

      <div className="border-line mt-4 flex flex-wrap items-end gap-2 border-t pt-4">
        <label className="space-y-1.5">
          <span className="text-muted block text-xs">Tipo</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="border-line bg-surface-2 rounded-[var(--radius)] border px-3 py-2 text-sm">
            {channels.data?.adapters.filter((a) => a.external).map((adapter) => (
              <option key={adapter.kind} value={adapter.kind}>{adapter.label}</option>
            ))}
          </select>
        </label>
        <label className="min-w-[16rem] flex-1 space-y-1.5">
          <span className="text-muted block text-xs">Destino (URL completa)</span>
          <input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="https://ntfy.midominio/mikampus" className="border-line bg-surface-2 w-full rounded-[var(--radius)] border px-3 py-2 text-sm outline-none" />
        </label>
        <button
          type="button"
          disabled={!destination.trim() || create.isPending}
          onClick={() => create.mutate({ kind, destination: destination.trim() })}
          className="bg-fg text-bg rounded-[var(--radius)] px-3 py-2 text-sm font-medium disabled:opacity-50"
        >
          Agregar apagado
        </button>
      </div>
      {create.error && <p className="text-closed mt-2 text-sm">{create.error.message}</p>}
      {test.data && <p className={test.data.ok ? 'text-open mt-2 text-sm' : 'text-closed mt-2 text-sm'}>{test.data.ok ? 'Prueba enviada.' : `La prueba falló: ${test.data.error}`}</p>}
    </section>
  );
}

// Copias (§7 y §8). El aviso de que una copia en el mismo disco no es disaster
// recovery viaja con los datos, no en una nota al pie del README.
function CopiasSection() {
  const queryClient = useQueryClient();
  const status = useAgentStatus();
  const [directory, setDirectory] = useState('');
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['agent-status'] });

  const backup = useMutation({ mutationFn: createBackupNow, onSuccess: invalidate });
  const retention = useMutation({ mutationFn: setBackupRetention, onSuccess: invalidate });
  const exportTo = useMutation({ mutationFn: exportBackupTo, onSuccess: invalidate });
  const state = status.data?.backup;

  return (
    <section className="border-line bg-surface rounded-[var(--radius)] border p-5">
      <h2 className="text-sm font-medium">Copias de seguridad</h2>
      <p className="text-muted mt-1 text-xs leading-5">{state?.sameDiskWarning}</p>
      <p className="text-muted mt-2 text-xs">
        Última copia verificada: {state?.lastSuccessfulAt ? ago(state.lastSuccessfulAt) : 'todavía ninguna'} · próxima:{' '}
        {state?.nextRunAt ? new Date(state.nextRunAt).toLocaleString('es-DO') : '—'} · se conservan {state?.keep ?? 0}
      </p>
      <p className="text-muted mt-1 font-mono text-xs break-all">{state?.directory}</p>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <button type="button" onClick={() => backup.mutate()} disabled={backup.isPending} className="border-line hover:bg-surface-2 rounded-[var(--radius)] border px-3 py-2 text-sm disabled:opacity-50">
          {backup.isPending ? 'Copiando…' : 'Hacer copia ahora'}
        </button>
        <label className="space-y-1.5">
          <span className="text-muted block text-xs">Copias a conservar</span>
          <input
            type="number"
            min={1}
            defaultValue={state?.keep ?? 7}
            onBlur={(e) => retention.mutate(Number(e.target.value))}
            className="border-line bg-surface-2 w-24 rounded-[var(--radius)] border px-3 py-2 text-sm outline-none"
          />
        </label>
      </div>

      <div className="border-line mt-4 flex flex-wrap items-end gap-2 border-t pt-4">
        <label className="min-w-[16rem] flex-1 space-y-1.5">
          <span className="text-muted block text-xs">Exportar a otra carpeta o disco</span>
          <input value={directory} onChange={(e) => setDirectory(e.target.value)} placeholder="/media/usb/mikampus" className="border-line bg-surface-2 w-full rounded-[var(--radius)] border px-3 py-2 text-sm outline-none" />
        </label>
        <button type="button" disabled={!directory.trim() || exportTo.isPending} onClick={() => exportTo.mutate(directory.trim())} className="border-line hover:bg-surface-2 rounded-[var(--radius)] border px-3 py-2 text-sm disabled:opacity-50">
          Exportar
        </button>
      </div>
      {exportTo.data && (
        <p className="text-open mt-2 text-sm">
          Copia verificada en {exportTo.data.file}.{exportTo.data.sameDisk ? ' Ojo: está en el mismo disco, no cubre robo ni daño físico.' : ''}
        </p>
      )}
      {exportTo.error && <p className="text-closed mt-2 text-sm">{exportTo.error.message}</p>}
    </section>
  );
}

// Diagnósticos (§10): quedan en la carpeta de la app, redactados, y solo salen
// de ahí con una acción explícita.
function DiagnosticosSection() {
  const diagnostics = useQuery({ queryKey: ['diagnostics'], queryFn: fetchDiagnostics });
  const [directory, setDirectory] = useState('');
  const exportTo = useMutation({ mutationFn: exportDiagnosticsTo });

  return (
    <section className="border-line bg-surface rounded-[var(--radius)] border p-5">
      <h2 className="text-sm font-medium">Diagnósticos</h2>
      <p className="text-muted mt-1 text-xs leading-5">{diagnostics.data?.note}</p>
      {!diagnostics.data?.files.length ? (
        <p className="text-muted mt-3 text-sm">No hay diagnósticos guardados.</p>
      ) : (
        <ul className="text-muted mt-3 space-y-1 text-xs">
          {diagnostics.data.files.map((file) => (
            <li key={file.name} className="font-mono break-all">
              {file.name} · {file.bytes} bytes{file.pii ? ' · captura del portal' : ''}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="min-w-[16rem] flex-1 space-y-1.5">
          <span className="text-muted block text-xs">Exportar a</span>
          <input value={directory} onChange={(e) => setDirectory(e.target.value)} placeholder="/home/vos/diagnosticos" className="border-line bg-surface-2 w-full rounded-[var(--radius)] border px-3 py-2 text-sm outline-none" />
        </label>
        <button type="button" disabled={!directory.trim() || exportTo.isPending} onClick={() => exportTo.mutate(directory.trim())} className="border-line hover:bg-surface-2 rounded-[var(--radius)] border px-3 py-2 text-sm disabled:opacity-50">
          Exportar
        </button>
      </div>
      {exportTo.error && <p className="text-closed mt-2 text-sm">{exportTo.error.message}</p>}
    </section>
  );
}

// Updates (§11): manual u apagado. No existe "automático" — sería tráfico
// periódico a GitHub que nadie pidió.
function ActualizacionesSection() {
  const queryClient = useQueryClient();
  const status = useAgentStatus();
  const check = useMutation({ mutationFn: checkForUpdate, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-status'] }) });
  const policy = useMutation({ mutationFn: setUpdatePolicy, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-status'] }) });
  const current = status.data?.update;

  return (
    <section className="border-line bg-surface rounded-[var(--radius)] border p-5">
      <h2 className="text-sm font-medium">Actualizaciones</h2>
      <p className="text-muted mt-1 text-xs leading-5">
        mikampus no consulta versiones por su cuenta. Cuando pulsás "Buscar", se pregunta una vez a GitHub; lo que se
        descargue se verifica por SHA-256 antes de instalarse, y el update detiene el agente y respalda la base antes de
        tocar nada.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => check.mutate()} disabled={check.isPending || current?.policy === 'off'} className="border-line hover:bg-surface-2 rounded-[var(--radius)] border px-3 py-2 text-sm disabled:opacity-50">
          {check.isPending ? 'Consultando…' : 'Buscar actualizaciones'}
        </button>
        <button type="button" onClick={() => policy.mutate(current?.policy === 'off' ? 'manual' : 'off')} className="text-muted hover:text-fg text-xs">
          {current?.policy === 'off' ? 'Permitir el chequeo manual' : 'Desactivar del todo el chequeo'}
        </button>
      </div>
      {check.data && (
        <p className="text-muted mt-2 text-sm">
          {check.data.status === 'update-available'
            ? `Hay una versión ${check.data.latest} (tenés la ${check.data.current}).`
            : check.data.status === 'error'
              ? `No se pudo consultar: ${check.data.error}`
              : `Estás en la última versión (${check.data.current}).`}
        </p>
      )}
    </section>
  );
}

// El preview de borrado (§9): qué se va a eliminar, dónde vive y qué no puede
// tocar mikampus. Un "borrar todo" sin esto es una promesa no verificable.
function ErasePreview() {
  const preview = useQuery({ queryKey: ['erase-preview'], queryFn: fetchErasePreview });
  if (!preview.data) return null;
  return (
    <div className="border-line mt-3 rounded-[var(--radius)] border p-3">
      <p className="text-xs font-medium">Esto es lo que se borra</p>
      <ul className="text-muted mt-2 space-y-1 text-xs leading-5">
        {preview.data.targets.map((target) => (
          <li key={target.id}>
            {target.label} — <span className="font-mono break-all">{target.path}</span>
            {target.exists ? ` (${Math.max(1, Math.round(target.bytes / 1024))} KiB)` : ' (no existe)'}
          </li>
        ))}
        {preview.data.external.map((item) => (
          <li key={item.id}>
            {item.label} — {item.purpose}
          </li>
        ))}
      </ul>
      <p className="text-muted mt-2 text-xs leading-5">
        {preview.data.note} Desde acá se borran tus datos, la credencial, las copias y los diagnósticos; para eliminar
        además el archivo de base y el browser descargado, corré <span className="font-mono">mikampus erase-data --yes</span>.
      </p>
      <p className="text-xs font-medium mt-3">Esto queda fuera de su alcance</p>
      <ul className="text-muted mt-1 space-y-1 text-xs leading-5">
        {preview.data.outsideReach.map((item) => (
          <li key={item.id}>
            {item.label} — {item.purpose}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Recordatorio antes de clase. Es lo que un agente local puede hacer y el
// portal no: mikampus ya sabe tu horario y ya sobrevive al navegador cerrado.
// Nace apagado — una app que empieza a notificar sola es una app que se
// desinstala.
function RecordatoriosSection() {
  const qc = useQueryClient();
  const reminders = useQuery({ queryKey: ['class-reminders'], queryFn: fetchClassReminders });
  const guardar = useMutation({
    mutationFn: setClassReminders,
    onSuccess: (fresh) => qc.setQueryData(['class-reminders'], fresh),
  });

  const data = reminders.data;
  const activo = data?.enabled ?? false;

  return (
    <section className="border-line bg-surface rounded-[var(--radius)] border p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-base font-semibold tracking-tight">Aviso antes de clase</h2>
          <p className="text-muted mt-1 text-sm">
            Un recordatorio con el aula y la hora, unos minutos antes de cada clase de hoy. Sale del horario que ya
            está guardado: no consulta el portal.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={activo}
          aria-label="Activar aviso antes de clase"
          disabled={guardar.isPending}
          onClick={() => guardar.mutate({ enabled: !activo })}
          className={`h-6 w-10 shrink-0 rounded-full p-0.5 transition-colors duration-100 ${
            activo ? 'bg-accent' : 'bg-surface-2 border-line border'
          }`}
        >
          <span
            className={`block size-5 rounded-full bg-white transition-transform duration-100 ${activo ? 'translate-x-4' : ''}`}
          />
        </button>
      </div>

      {activo && (
        <div className="mt-4 space-y-3">
          <label className="flex flex-wrap items-center gap-2 text-sm">
            Avisarme
            <input
              type="number"
              min={5}
              max={120}
              step={5}
              defaultValue={data?.leadMinutes ?? 20}
              onBlur={(event) => guardar.mutate({ leadMinutes: Number(event.target.value) })}
              className="border-line bg-bg tabular w-20 rounded-[var(--radius)] border px-2 py-1.5 font-mono text-sm"
            />
            minutos antes
          </label>

          {data?.next ? (
            <p className="text-muted text-sm">
              Próxima clase hoy: <span className="text-fg font-medium">{data.next.title}</span> a las{' '}
              <span className="tabular font-mono">{data.next.start}</span>
              {data.next.room ? ` en ${data.next.room}` : ''} ·{' '}
              {data.next.willNotify ? 'se va a avisar' : 'ya está dentro del margen, no se avisará'}.
            </p>
          ) : (
            <p className="text-muted text-sm">Hoy no queda ninguna clase por delante.</p>
          )}

          <p className="text-muted text-xs">
            En Local Desktop el aviso llega solo con el equipo encendido y despierto. Un recordatorio atrasado no se
            envía: si el agente estuvo dormido y la clase ya empezó, avisar no ayuda.
          </p>
        </div>
      )}
      {guardar.error && <p className="text-closed mt-2 text-sm">{(guardar.error as Error).message}</p>}
    </section>
  );
}

// Notificaciones push (§5.5): la mitad accionable del watcher. Sin esto, "apareció
// cupo" solo existe si tenés la app abierta. El permiso lo da el usuario con un
// gesto (no se pide a ciegas), y en iPhone solo funciona con la app instalada al
// inicio — la UI lo dice en vez de dejar un botón que no hace nada.
function NotificacionesSection() {
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: ['push-state'], queryFn: getPushState, staleTime: 0 });

  const enable = useMutation({
    mutationFn: enablePush,
    onSuccess: (s) => queryClient.setQueryData(['push-state'], s),
  });
  const disable = useMutation({
    mutationFn: disablePush,
    onSuccess: (s) => queryClient.setQueryData(['push-state'], s),
  });

  const s = state.data;
  const busy = enable.isPending || disable.isPending;

  return (
    <section className="border-line bg-surface rounded-[var(--radius)] border p-5">
      <h2 className="text-sm font-medium">Notificaciones</h2>
      <p className="text-muted mt-1 text-xs leading-5">
        Cuando abra un cupo de una materia que vigilás, mikampus te avisa al instante — aunque tengas la app cerrada.
      </p>

      <div className="border-line mt-3 flex flex-wrap items-center justify-between gap-4 border-t pt-3">
        {!s ? (
          <p className="text-muted text-sm">Revisando…</p>
        ) : !s.supported ? (
          <p className="text-muted text-sm leading-6">
            Este dispositivo no puede recibir notificaciones push. En iPhone necesitás{' '}
            <span className="text-fg">instalar mikampus en tu pantalla de inicio</span> (Compartir → Agregar a inicio) y abrirla desde ahí.
          </p>
        ) : s.permission === 'denied' ? (
          <p className="text-muted text-sm leading-6">
            Bloqueaste las notificaciones para mikampus. Activalas de nuevo desde los ajustes de tu navegador para este sitio.
          </p>
        ) : s.subscribed ? (
          <>
            <p className="text-open text-sm">Activadas en este dispositivo.</p>
            <button
              type="button"
              onClick={() => disable.mutate()}
              disabled={busy}
              className="border-line hover:bg-surface-2 rounded-[var(--radius)] border px-3 py-2 text-sm font-medium disabled:opacity-50"
            >
              {disable.isPending ? 'Desactivando…' : 'Desactivar'}
            </button>
          </>
        ) : (
          <>
            <p className="text-muted text-sm">Todavía no las activaste en este dispositivo.</p>
            <button
              type="button"
              onClick={() => enable.mutate()}
              disabled={busy}
              className="bg-fg text-bg rounded-[var(--radius)] px-3 py-2 text-sm font-medium disabled:opacity-50"
            >
              {enable.isPending ? 'Activando…' : 'Activar notificaciones'}
            </button>
          </>
        )}
      </div>
      {enable.error && <p className="text-closed mt-2 text-sm">{enable.error.message}</p>}
    </section>
  );
}
