import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchAccount, saveAccount } from '../lib/api.ts';

// Cambiar de cuenta desde la página en vez de editar el .env y reiniciar. El
// backend hace el trabajo pesado (tira la sesión, borra el cache personal); acá
// solo mandamos las credenciales y, al volver, descartamos las queries de datos
// personales para que las pantallas se repinten vacías hasta el próximo sync.
const PERSONAL_QUERIES = ['cart', 'grades', 'holds', 'my-schedule', 'pensum'];

export function Ajustes() {
  const queryClient = useQueryClient();
  const { data: account } = useQuery({ queryKey: ['account'], queryFn: fetchAccount });

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const save = useMutation({
    mutationFn: saveAccount,
    onSuccess: (fresh) => {
      queryClient.setQueryData(['account'], fresh);
      // removeQueries, no invalidateQueries: invalidar deja el dato viejo en
      // cache y lo repinta (stale-while-revalidate) mientras refetchea, así que
      // la pantalla mostraba a la persona anterior por un instante. Al borrarlo
      // del cache, ninguna pantalla puede repintarlo: entra en loading y pide de
      // nuevo, que ya es el backend vacío hasta el próximo sync.
      for (const key of PERSONAL_QUERIES) queryClient.removeQueries({ queryKey: [key] });
      setPassword('');
    },
  });

  const canSave = username.trim().length > 0 && password.length > 0 && !save.isPending;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Ajustes</h1>
      </header>

      <section className="border-line bg-surface space-y-4 rounded-[var(--radius)] border p-5">
        <div>
          <h2 className="text-sm font-medium">Cuenta del portal</h2>
          <p className="text-muted mt-1 text-xs">
            {account?.configured ? (
              <>
                Estás usando <span className="text-fg font-medium">{account.username}</span>{' '}
                <span className="text-muted">({account.source === '.env' ? 'desde el .env' : 'guardada en la app'})</span>.
              </>
            ) : (
              'Todavía no hay ninguna cuenta configurada.'
            )}
          </p>
        </div>

        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) save.mutate({ username: username.trim(), password });
          }}
        >
          <label className="block space-y-1">
            <span className="text-muted text-xs">Usuario</span>
            <input
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={account?.username ?? 'tu usuario del portal'}
              className="border-line bg-surface-2 focus:border-accent w-full rounded-[var(--radius)] border px-3 py-2 text-sm outline-none"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-muted text-xs">Contraseña</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="border-line bg-surface-2 focus:border-accent w-full rounded-[var(--radius)] border px-3 py-2 text-sm outline-none"
            />
          </label>

          <button
            type="submit"
            disabled={!canSave}
            className="bg-accent text-accent-fg rounded-[var(--radius)] px-3 py-2 text-sm font-medium disabled:opacity-50"
          >
            {save.isPending ? 'Cambiando de cuenta…' : 'Cambiar de cuenta'}
          </button>
        </form>

        {save.error && <p className="text-closed text-sm">No se pudo cambiar la cuenta: {save.error.message}</p>}
        {save.isSuccess && !save.isPending && (
          <p className="text-open text-sm">
            Cuenta cambiada. Tus notas, horario, pénsum, carrito y holds se vaciaron: entrá a cada pantalla y
            sincronizá para traerlos de la cuenta nueva.
          </p>
        )}

        <p className="text-muted border-line border-t pt-3 text-xs">
          Al cambiar de cuenta se cierra la sesión abierta del portal y se borran los datos personales cacheados
          (notas, horario, pénsum, carrito y holds). El catálogo de materias y tus planes se conservan. La contraseña
          se guarda solo en tu máquina.
        </p>
      </section>
    </div>
  );
}
