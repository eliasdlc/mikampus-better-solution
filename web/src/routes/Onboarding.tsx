import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Check, Loader2, X } from 'lucide-react';
import { chooseRuntimeMode, fetchOnboarding, startBrowserInstall, type OnboardingState } from '../lib/api.ts';

// Primer uso (Fase 4 §1 y §2). El orden de esta pantalla es el contrato: elegir
// modo → verificar prerequisitos → bajar el browser → recién ahí pedir la
// cuenta. Nunca al revés: una contraseña que llega antes de que exista Chromium
// es una contraseña que no podemos verificar y hay que sostener mientras tanto.

export function Onboarding() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: ['onboarding'],
    queryFn: fetchOnboarding,
    // Mientras se descarga el browser el progreso viene del agente, no del
    // navegador: si cerrás la pestaña, la descarga sigue.
    refetchInterval: (query) => (query.state.data?.browser.install.status === 'running' ? 800 : false),
  });

  const chooseMode = useMutation({
    mutationFn: chooseRuntimeMode,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['onboarding'] }),
  });
  const install = useMutation({
    mutationFn: startBrowserInstall,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['onboarding'] }),
  });

  const data = state.data;
  const actionError = chooseMode.error ?? install.error;

  if (!data) {
    return <main className="text-muted flex min-h-full items-center justify-center text-sm">Revisando esta instalación…</main>;
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-12">
      <h1 className="font-display text-3xl font-semibold tracking-tight">Configurar mikampus</h1>
      <p className="text-muted mt-2 text-sm leading-6">
        Tus datos, tu cuenta y tu hardware. mikampus no está afiliada ni respaldada por PUCMM: la vas a usar con tu
        propia cuenta y bajo tu responsabilidad.
      </p>
      {actionError && <p role="alert" className="text-closed mt-4 text-sm">No se pudo continuar: {actionError.message}</p>}

      <Step index={1} title="Elegí cómo va a correr" done={Boolean(data.mode)} active={data.step === 'mode'}>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {data.modes.map((mode) => (
            <button
              key={mode.id}
              type="button"
              onClick={() => chooseMode.mutate(mode.id as 'desktop' | 'home-server')}
              disabled={chooseMode.isPending}
              className={`rounded-[var(--radius)] border p-4 text-left transition-colors ${
                data.mode === mode.id ? 'border-accent bg-surface-2' : 'border-line hover:bg-surface-2'
              }`}
            >
              <p className="text-sm font-medium">{mode.label}</p>
              <p className="text-muted mt-1 text-xs leading-5">{mode.summary}</p>
              <ul className="text-muted mt-2 space-y-1 text-xs leading-5">
                {mode.guarantees.map((item) => (
                  <li key={item}>· {item}</li>
                ))}
              </ul>
            </button>
          ))}
        </div>
      </Step>

      <Step
        index={2}
        title="Prerequisitos de este equipo"
        done={data.prerequisites.every((check) => check.ok)}
        active={data.step === 'prerequisites'}
      >
        <ul className="mt-3 space-y-2 text-sm">
          {data.prerequisites.map((check) => (
            <li key={check.id} className="flex items-start gap-2">
              {check.ok ? <Check className="text-open mt-0.5 size-4 shrink-0" /> : <X className="text-closed mt-0.5 size-4 shrink-0" />}
              <span>
                {check.label}
                <span className="text-muted block font-mono text-xs break-all">{check.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </Step>

      <Step index={3} title="Browser administrado" done={data.browser.installed} active={data.step === 'browser'}>
        {data.browser.source === 'system' ? (
          <p className="text-muted mt-2 text-xs leading-5">
            Se va a reutilizar el navegador compatible ya instalado en este equipo. mikampus lo controla en segundo plano y no instala otro navegador.
          </p>
        ) : (
          <p className="text-muted mt-2 text-xs leading-5">
            Si este equipo no tiene Chrome o Chromium, mikampus descarga un Chromium aislado a{' '}
            <span className="font-mono break-all">{data.browser.root}</span>; no se instala en tu sistema.
          </p>
        )}
        {data.browser.installed ? (
          <p className="text-open mt-3 text-sm">{data.browser.source === 'system' ? 'Navegador compatible encontrado.' : 'Browser administrado listo para usar.'}</p>
        ) : (
          <BrowserInstall state={data} onStart={() => install.mutate()} pending={install.isPending} />
        )}
      </Step>

      <Step index={4} title="Tu cuenta de PUCMM" done={data.account} active={data.step === 'credentials'}>
        <p className="text-muted mt-2 text-xs leading-5">
          Recién ahora se te pide la contraseña, cuando mikampus ya puede verificarla contra micampus. Queda guardada
          en un archivo tuyo, solo legible por tu usuario, para que el agente pueda volver al portal sin pedírtela.
        </p>
        <button
          type="button"
          disabled={!data.browser.installed}
          onClick={() => navigate('/entrar')}
          className="bg-accent text-accent-fg mt-4 rounded-[var(--radius)] px-3 py-2 text-sm font-medium disabled:opacity-50"
        >
          Continuar al inicio de sesión
        </button>
      </Step>
    </main>
  );
}

function BrowserInstall({ state, onStart, pending }: { state: OnboardingState; onStart: () => void; pending: boolean }) {
  const install = state.browser.install;

  if (install.status === 'running') {
    return (
      <div className="mt-3">
        <div className="bg-surface-2 h-2 w-full overflow-hidden rounded-full">
          <div className="bg-accent h-full transition-[width] duration-300" style={{ width: `${install.percent}%` }} />
        </div>
        <p className="text-muted mt-2 flex items-center gap-2 text-xs">
          <Loader2 className="size-3" aria-hidden />
          {install.percent}% · {install.message ?? 'descargando'}
        </p>
        <p className="text-muted mt-1 text-xs">Podés cerrar esta pestaña: la descarga la hace el agente, no el navegador.</p>
      </div>
    );
  }

  return (
    <div className="mt-3">
      {install.status === 'error' && <p className="text-closed mb-2 text-sm">No se pudo descargar: {install.error}</p>}
      <button
        type="button"
        onClick={onStart}
        disabled={pending}
        className="bg-fg text-bg rounded-[var(--radius)] px-3 py-2 text-sm font-medium disabled:opacity-50"
      >
        {install.status === 'error' ? 'Reintentar descarga' : 'Descargar browser'}
      </button>
    </div>
  );
}

function Step({
  index,
  title,
  done,
  active,
  children,
}: {
  index: number;
  title: string;
  done: boolean;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={`border-line bg-surface mt-4 rounded-[var(--radius)] border p-5 ${active ? '' : 'opacity-80'}`}>
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <span
          className={`flex size-5 items-center justify-center rounded-full text-xs ${
            done ? 'bg-open text-white' : 'bg-surface-2 text-muted'
          }`}
        >
          {done ? '✓' : index}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}
