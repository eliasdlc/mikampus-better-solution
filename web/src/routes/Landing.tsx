import { Link } from 'react-router-dom';

export function Landing() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col justify-center px-5 py-12 sm:px-8">
      <div className="border-line bg-surface grid overflow-hidden rounded-[calc(var(--radius)*1.5)] border lg:grid-cols-[1.1fr_.9fr]">
        <section className="p-7 sm:p-10">
          <p className="text-muted text-sm font-medium">para estudiantes PUCMM</p>
          <h1 className="font-display mt-3 max-w-xl text-5xl font-semibold tracking-[-0.04em] text-balance sm:text-6xl">
            Tu carrera, clara antes de que empiece el día.
          </h1>
          <p className="text-muted mt-5 max-w-lg text-base leading-7">
            mikampus reúne tu horario, avance y carrito de inscripción. Tus datos se ven al instante; solo se consulta
            PeopleSoft cuando hace falta.
          </p>
          <Link to="/entrar" className="bg-accent text-accent-fg mt-7 inline-block rounded-[var(--radius)] px-4 py-2.5 text-sm font-medium">
            Entrar a mikampus
          </Link>
          <p className="text-muted mt-5 text-xs">Beta por invitación. Usás tu cuenta normal de micampus; no creamos otra.</p>
        </section>
        <section className="bg-surface-2 border-line flex flex-col justify-between border-t p-7 lg:border-t-0 lg:border-l sm:p-10">
          <div>
            <p className="font-display text-xl font-semibold tracking-tight">Una herramienta, no otra bandeja de ruido.</p>
            <ul className="text-muted mt-5 space-y-3 text-sm leading-6">
              <li>Horario y notas guardados en tu espacio privado.</li>
              <li>Avance de carrera y planes para el próximo ciclo.</li>
              <li>Acciones de inscripción auditables, con respuesta del portal.</li>
            </ul>
          </div>
          <p className="text-muted mt-10 text-sm">Código abierto: podés correr mikampus completo en tu propia máquina.</p>
        </section>
      </div>
    </main>
  );
}
