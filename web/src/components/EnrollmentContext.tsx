import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  cancelSchedule,
  fetchEnrollmentWindows,
  fetchHolds,
  fetchState,
  runSync,
  scheduleAt,
  setWatcher,
  syncEnrollmentWindows,
  validateCart,
  type WatcherScope,
} from '../lib/api.ts';
import type { TermInfo } from '../../../src/shared/schemas.ts';
import { Countdown } from './Countdown.tsx';
import { ago } from '../lib/time.ts';

// La columna contextual de Inscripción (P2 §5). Antes mezclaba tres cosas que
// no son la misma: el rango que publica la universidad, la hora personal en que
// TE toca inscribirte, y el disparo que mikampus va a ejecutar. Confundirlas es
// caro — alguien que lee "27 de julio" y entiende "puedo inscribirme el 27 a
// las 00:00" pierde el cupo a las 7am.
//
// Acá van separadas, cada una con su fuente, y ninguna se infiere de la otra.

const SCOPE_OPTIONS: { id: WatcherScope; title: string; detail: string }[] = [
  {
    id: 'seats',
    title: 'Solo cupos de mis secciones',
    detail: 'Avisa cuando se libere un asiento en el NRC exacto que tenés en el carrito. Entrás sin cambiar tu horario.',
  },
  {
    id: 'groups',
    title: 'Solo grupos nuevos',
    detail: 'Avisa cuando la universidad abra un NRC que antes no existía. Implica cambiarte de sección.',
  },
  { id: 'both', title: 'Ambas', detail: 'Todo lo anterior. Es lo que hacía el watcher antes de poder elegir.' },
];

function longDate(iso: string) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString('es-DO', { day: 'numeric', month: 'short', year: 'numeric' });
}

function Card({ title, source, children }: { title: string; source?: string; children: React.ReactNode }) {
  return (
    <section className="border-line bg-surface space-y-3 rounded-[var(--radius)] border p-4">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        {source && <p className="text-muted text-xs">{source}</p>}
      </div>
      {children}
    </section>
  );
}

export function EnrollmentContext({
  term,
  cartRows,
  hasCollision,
  hasClosedSection,
  onResolveTerm,
}: {
  term: TermInfo | null;
  cartRows: number;
  hasCollision: boolean;
  hasClosedSection: boolean;
  onResolveTerm: () => void;
}) {
  const qc = useQueryClient();
  const termId = term?.term ?? undefined;
  const state = useQuery({ queryKey: ['state'], queryFn: fetchState });
  const holds = useQuery({ queryKey: ['holds'], queryFn: fetchHolds });
  const windows = useQuery({
    queryKey: ['enrollment-windows', termId],
    queryFn: () => fetchEnrollmentWindows(termId),
    enabled: Boolean(termId),
  });

  const [manualAt, setManualAt] = useState('');

  const refreshWindow = useMutation({
    mutationFn: () => syncEnrollmentWindows(termId),
    onSuccess: (fresh) => qc.setQueryData(['enrollment-windows', termId], fresh),
  });
  const validation = useMutation({ mutationFn: validateCart });
  const unschedule = useMutation({
    mutationFn: cancelSchedule,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['state'] }),
  });

  const enrollmentWindow = windows.data?.windows[0] ?? null;
  const scheduledAt = state.data?.schedule?.atISO;
  const watcherOn = Boolean(state.data?.watcher);
  const autoEnrollOn = state.data?.watcher?.autoEnroll ?? false;
  const activeScope = state.data?.watcher?.scope ?? 'both';
  const [pendingScope, setPendingScope] = useState<WatcherScope>('both');
  const scope: WatcherScope = watcherOn ? activeScope : pendingScope;

  // La hora personal solo existe si el portal la publicó con hora. Un rango con
  // precisión de día NO autoriza a suponer una hora — ni medianoche ni ninguna.
  const portalAppointment = enrollmentWindow?.precision === 'datetime' ? enrollmentWindow.startsAt : null;

  const schedule = useMutation({
    mutationFn: () => {
      const chosen = portalAppointment ?? manualAt;
      if (!chosen) return Promise.reject(new Error('Escribí la hora que te comunicó tu escuela.'));
      const expiresAt = enrollmentWindow?.endsAt ?? 'el cierre de inscripción';
      if (!window.confirm(`Para ejecutar el disparo aunque cierres la app, mikampus guardará tu credencial cifrada hasta ${expiresAt}. ¿Aceptás?`)) {
        return Promise.reject(new Error('No autorizaste el disparo programado.'));
      }
      return scheduleAt({ atISO: new Date(chosen).toISOString(), term: termId, consent: true });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['state'] }),
  });

  const watch = useMutation({
    mutationFn: (input: { enabled: boolean; autoEnroll?: boolean; scope?: WatcherScope }) => {
      const raisesAuthority = (input.enabled && !watcherOn) || (input.autoEnroll === true && !autoEnrollOn);
      if (raisesAuthority) {
        const expiresAt = enrollmentWindow?.endsAt ?? 'el cierre de inscripción';
        const purpose = input.autoEnroll
          ? 'Auto-inscripción puede modificar tu matrícula'
          : 'El watcher consulta el portal aunque la pestaña esté cerrada';
        if (!window.confirm(`${purpose}. Se guardará tu credencial cifrada hasta ${expiresAt}. ¿Aceptás?`)) {
          return Promise.reject(new Error('No autorizaste la auto-inscripción.'));
        }
      }
      return setWatcher({ ...input, term: termId, appointmentAt: scheduledAt ?? null, consent: true });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['state'] }),
  });

  // Qué le falta al watcher para poder encenderse. Nunca "elegí un ciclo" a
  // secas: o falta el ciclo (y el selector está arriba), o falta el STRM (y hay
  // una acción concreta), o falta qué vigilar (y se dice cuál).
  const watcherBlocker = !term
    ? { text: 'Elegí un ciclo en el selector de arriba para poder vigilar sus cupos.', action: null }
    : !term.code
      ? {
          text: `mikampus todavía no conoce el código interno de ${term.label ?? term.term}. Sin él, PeopleSoft no acepta la consulta de cupos.`,
          action: { label: 'Buscar ciclos en PeopleSoft', run: onResolveTerm },
        }
      : cartRows === 0
        ? { text: 'Agregá al carrito la sección que querés vigilar: el watcher observa NRCs concretos, no materias en abstracto.', action: null }
        : null;

  const activeHolds = holds.data?.holds ?? [];

  return (
    <aside className="space-y-4">
      {/* ── 1. Período general ─────────────────────────────────────────── */}
      <Card
        title="Período general de inscripción"
        source={`PeopleSoft · ${term?.label ?? term?.term ?? 'sin ciclo elegido'}`}
      >
        {enrollmentWindow ? (
          <div>
            <div className="tabular font-display text-xl font-semibold tracking-tight">
              {longDate(enrollmentWindow.startsAt)}
            </div>
            <p className="text-muted mt-0.5 text-xs">hasta el {longDate(enrollmentWindow.endsAt)}</p>
            <p className="text-muted mt-2 text-xs">
              Es el rango que la universidad abre para todo el mundo. No es la hora en que te toca a vos.
            </p>
          </div>
        ) : (
          <p className="text-muted text-xs">
            {termId ? 'Todavía no leíste Enrollment Dates para este ciclo.' : 'Elegí un ciclo para leer su período.'}
          </p>
        )}
        <div className="flex items-center justify-between">
          <span className="text-muted text-xs">
            {windows.data?.syncedAt ? `actualizado ${ago(windows.data.syncedAt)}` : 'sin leer'}
          </span>
          <button
            type="button"
            onClick={() => refreshWindow.mutate()}
            disabled={refreshWindow.isPending || !termId}
            className="text-accent text-xs font-medium underline underline-offset-2 disabled:opacity-50"
          >
            {refreshWindow.isPending ? 'leyendo…' : 'actualizar'}
          </button>
        </div>
        {refreshWindow.error && <p className="text-closed text-xs">{(refreshWindow.error as Error).message}</p>}
      </Card>

      {/* ── 2. Tu hora personal ────────────────────────────────────────── */}
      <Card
        title="Tu hora de inscripción"
        source={portalAppointment ? 'confirmada por PeopleSoft' : 'no publicada por el portal'}
      >
        {scheduledAt ? (
          <div className="space-y-2">
            <Countdown toISO={scheduledAt} />
            <div className="text-muted text-xs">
              {new Date(scheduledAt).toLocaleString('es-DO')}
              <button onClick={() => unschedule.mutate()} className="text-closed ml-2 underline underline-offset-2">
                cancelar
              </button>
            </div>
            <p className="text-muted text-xs">
              {state.data?.schedule?.prewarmed
                ? 'El asistente ya está preparado; a la hora exacta solo se enviará.'
                : 'mikampus prepara la sesión unos minutos antes para que a la hora exacta solo quede enviar.'}
            </p>
          </div>
        ) : portalAppointment ? (
          <div className="space-y-2">
            <p className="text-sm">{new Date(portalAppointment).toLocaleString('es-DO')}</p>
            <button
              onClick={() => schedule.mutate()}
              disabled={schedule.isPending}
              className="bg-accent text-accent-fg w-full rounded-[var(--radius)] px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            >
              Programar inscripción
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Marcado como dato tuyo, no del portal: es la diferencia entre
                "esto lo dijo PUCMM" y "esto lo escribí yo". */}
            <p className="border-waitlist/40 bg-waitlist/10 text-waitlist rounded-[var(--radius)] border px-2.5 py-2 text-xs">
              El portal publica la fecha pero no la hora. Escribí la que te comunicó tu escuela — mikampus no la va a
              adivinar ni va a asumir medianoche.
            </p>
            <input
              type="datetime-local"
              value={manualAt}
              onChange={(event) => setManualAt(event.target.value)}
              aria-label="Hora de inscripción comunicada por tu escuela"
              className="border-line bg-bg w-full rounded-[var(--radius)] border px-2 py-1.5 text-sm"
            />
            <button
              disabled={!manualAt || schedule.isPending}
              onClick={() => schedule.mutate()}
              className="bg-accent text-accent-fg w-full rounded-[var(--radius)] px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            >
              Programar inscripción
            </button>
          </div>
        )}
        {schedule.error && <p className="text-closed text-xs">{(schedule.error as Error).message}</p>}
      </Card>

      {/* ── 3. Validación previa ───────────────────────────────────────── */}
      <Card title="Validación previa" source="qué puede frenarte antes de someter">
        <ul className="space-y-1.5 text-xs">
          <Check ok={activeHolds.length === 0} label={activeHolds.length ? `${activeHolds.length} hold(s) activos` : 'Sin holds'} />
          <Check ok={!hasCollision} label={hasCollision ? 'Hay secciones que chocan en el horario' : 'Sin choques de horario'} />
          <Check
            ok={!hasClosedSection}
            label={hasClosedSection ? 'Hay secciones cerradas en el carrito' : 'Todas las secciones del carrito tienen cupo'}
          />
          <Check ok={cartRows > 0} label={cartRows > 0 ? `${cartRows} materia(s) en el carrito` : 'El carrito está vacío'} />
        </ul>
        <p className="text-muted text-xs">
          Los prerrequisitos no aparecen acá: PeopleSoft no los publica en ninguna pantalla que podamos leer.
        </p>
        <button
          type="button"
          onClick={() => validation.mutate()}
          disabled={validation.isPending || cartRows === 0}
          className="border-line hover:bg-surface-2 w-full rounded-[var(--radius)] border px-3 py-2 text-sm font-medium disabled:opacity-50"
        >
          Validar carrito
        </button>
        {validation.data && !validation.data.validate.supported && (
          <div className="border-line bg-bg rounded-[var(--radius)] border p-2.5 text-xs">
            <p className="font-medium">Validate no está habilitado por PUCMM</p>
            <p className="text-muted mt-1">{validation.data.validate.reason}</p>
            <p className="text-muted mt-2">
              Waitlist: {validation.data.waitlistChoice.reason} {validation.data.waitlistPosition.reason}
            </p>
          </div>
        )}
        {validation.error && <p className="text-closed text-xs">{(validation.error as Error).message}</p>}
      </Card>

      {/* ── 4. Watcher ─────────────────────────────────────────────────── */}
      <Card title="Watcher de cupos">
        {watcherBlocker ? (
          <div className="space-y-2">
            <p className="text-muted text-xs">{watcherBlocker.text}</p>
            {watcherBlocker.action && (
              <button
                type="button"
                onClick={watcherBlocker.action.run}
                className="border-line hover:bg-surface-2 w-full rounded-[var(--radius)] border px-3 py-2 text-sm font-medium"
              >
                {watcherBlocker.action.label}
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="text-muted text-xs">
                {watcherOn
                  ? `Ciclo efectivo: cada ${Math.round((state.data?.watcher?.intervalMs ?? 45_000) / 1000)}s.`
                  : 'Apagado. Solo consulta cuando vos lo encendés.'}
              </span>
              <button
                role="switch"
                aria-checked={watcherOn}
                aria-label="Activar watcher de cupos"
                onClick={() => watch.mutate({ enabled: !watcherOn, autoEnroll: false, scope })}
                className={`h-6 w-10 shrink-0 rounded-full p-0.5 transition-colors duration-100 ${watcherOn ? 'bg-accent' : 'bg-surface-2 border-line border'}`}
              >
                <span className={`block size-5 rounded-full bg-white transition-transform duration-100 ${watcherOn ? 'translate-x-4' : ''}`} />
              </button>
            </div>

            <fieldset className="space-y-1.5">
              <legend className="text-xs font-medium">Qué vigilar</legend>
              {SCOPE_OPTIONS.map((option) => (
                <label
                  key={option.id}
                  className={`border-line flex items-start gap-2 rounded-[var(--radius)] border p-2.5 text-xs ${scope === option.id ? 'bg-surface-2' : ''}`}
                >
                  <input
                    type="radio"
                    name="watcher-scope"
                    checked={scope === option.id}
                    disabled={watch.isPending}
                    onChange={() => {
                      setPendingScope(option.id);
                      if (watcherOn) {
                        watch.mutate({
                          enabled: true,
                          scope: option.id,
                          autoEnroll: option.id === 'groups' ? false : autoEnrollOn,
                        });
                      }
                    }}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block font-medium">{option.title}</span>
                    <span className="text-muted">{option.detail}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            {watcherOn && (
              <label className={`border-line flex items-start gap-2 rounded-[var(--radius)] border p-2.5 text-xs ${scope === 'groups' ? 'opacity-60' : ''}`}>
                <input
                  type="checkbox"
                  checked={autoEnrollOn}
                  disabled={watch.isPending || scope === 'groups'}
                  onChange={(event) => watch.mutate({ enabled: true, autoEnroll: event.target.checked, scope })}
                  className="mt-0.5"
                />
                <span>
                  <span className="block font-medium">Inscribirme al instante si abre cupo</span>
                  <span className="text-muted">
                    {scope === 'groups'
                      ? 'No aplica vigilando solo grupos nuevos: una sección que no elegiste nunca se inscribe sola.'
                      : autoEnrollOn
                        ? 'Activo con cola FIFO. Si no conocemos tu hora exacta, solo te avisará hasta que abra.'
                        : 'Por defecto solo avisa; activarlo pide consentimiento explícito.'}
                  </span>
                </span>
              </label>
            )}
            {state.data?.watcher?.queue.map((item) => (
              <p key={item.courseCode} className="text-muted text-xs">
                Fila de {item.courseCode}: posición {item.position} de {item.total}.
              </p>
            ))}
          </>
        )}
        {watch.error && <p className="text-closed text-xs">{(watch.error as Error).message}</p>}
      </Card>
    </aside>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className="flex items-start gap-2">
      <span className={`mt-1 size-1.5 shrink-0 rounded-full ${ok ? 'bg-open' : 'bg-waitlist'}`} aria-hidden />
      <span className={ok ? 'text-muted' : ''}>{label}</span>
    </li>
  );
}

// El descubrimiento de ciclos que ofrece el bloque del watcher: fuerza las
// fuentes que traen el STRM (ciclos + horario) por el mismo orquestador que
// todo lo demás, en vez de mandarle al backend un término inventado.
export function useTermDiscovery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => runSync({ force: true, keys: ['mySchedule'] }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['term-context'] });
      qc.invalidateQueries({ queryKey: ['terms'] });
    },
  });
}
