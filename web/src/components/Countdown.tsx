import { useEffect, useState } from 'react';

// Countdown grande (plan §5.1 y §5.7): Bricolage para los números expresivos y
// tabulares para que no bailen al cambiar cada segundo.
//
// Cuenta hasta `toISO` y se detiene en cero: nunca cuenta hacia atrás. Un
// "faltan -3 minutos" no es información, y quien lo muestre ya decidió qué
// decir en su lugar ("en curso", "disparando…").
export function Countdown({ toISO, size = 'lg' }: { toISO: string; size?: 'lg' | 'sm' }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const total = Math.max(0, Math.floor((new Date(toISO).getTime() - now) / 1000));
  const days = Math.floor(total / 86400);
  const pad = (n: number) => String(n).padStart(2, '0');
  const clock = `${pad(Math.floor((total % 86400) / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;

  return (
    <div className={`font-display tabular font-semibold tracking-tight ${size === 'lg' ? 'text-3xl' : 'text-xl'}`}>
      {days > 0 && <span>{days}d </span>}
      {clock}
    </div>
  );
}
