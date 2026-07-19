import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { deleteAllMyData, fetchAccountOverview, fetchActions, refreshExpiredData } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { ThemeToggle } from '../components/ThemeToggle.tsx';
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

  const refresh = useMutation({
    mutationFn: refreshExpiredData,
    onSuccess: () => {
      for (const key of PERSONAL_QUERIES) queryClient.invalidateQueries({ queryKey: [key] });
      queryClient.invalidateQueries({ queryKey: ['account-overview'] });
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

      <NotificacionesSection />

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
          <p className="text-muted mt-3 text-xs leading-5">
            Si borrás tus datos, mikampus elimina tu información, planes, historial y cualquier credencial cifrada. Tu cuenta de micampus no se toca. Las copias de seguridad dejan de contenerlos en un máximo de 3 días.
          </p>
          <label className="mt-4 block space-y-1.5">
            <span className="text-muted text-xs">Escribí <span className="font-mono text-fg">BORRAR</span> para confirmar</span>
            <input value={confirmDelete} onChange={(e) => setConfirmDelete(e.target.value)} className="border-line bg-surface-2 focus:border-closed w-full rounded-[var(--radius)] border px-3 py-2 text-sm outline-none" />
          </label>
          <button
            type="button"
            onClick={() => erase.mutate()}
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
