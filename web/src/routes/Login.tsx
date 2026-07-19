import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.tsx';

export function Login() {
  const navigate = useNavigate();
  const { authenticated, login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (authenticated) return <Navigate to="/" replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password || pending) return;
    setPending(true);
    setError(null);
    try {
      await login({ username: username.trim(), password });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo iniciar sesión');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-full max-w-md items-center px-5 py-12">
      <section className="border-line bg-surface w-full rounded-[calc(var(--radius)*1.5)] border p-6 sm:p-8">
        <Link to="/" className="font-display text-lg font-semibold tracking-tight">mikampus</Link>
        <h1 className="font-display mt-8 text-3xl font-semibold tracking-tight">Entrá con tu cuenta PUCMM</h1>
        <p className="text-muted mt-2 text-sm leading-6">
          Verificamos tu cuenta directamente con micampus. La contraseña sirve para esta sesión y no se guarda de forma permanente.
        </p>
        <form className="mt-6 space-y-4" onSubmit={submit}>
          <label className="block space-y-1.5">
            <span className="text-muted text-xs">Usuario</span>
            <input className="border-line bg-surface-2 focus:border-accent w-full rounded-[var(--radius)] border px-3 py-2.5 text-sm outline-none" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label className="block space-y-1.5">
            <span className="text-muted text-xs">Contraseña</span>
            <input className="border-line bg-surface-2 focus:border-accent w-full rounded-[var(--radius)] border px-3 py-2.5 text-sm outline-none" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && <p className="text-closed text-sm">{error}</p>}
          <button disabled={pending || !username.trim() || !password} className="bg-accent text-accent-fg w-full rounded-[var(--radius)] px-3 py-2.5 text-sm font-medium disabled:opacity-50">
            {pending ? 'Verificando con micampus…' : 'Entrar'}
          </button>
        </form>
        <p className="text-muted mt-5 text-xs leading-5">
          Las funciones programadas te pedirán consentimiento aparte antes de guardar una credencial cifrada y con fecha de vencimiento.
        </p>
      </section>
    </main>
  );
}
