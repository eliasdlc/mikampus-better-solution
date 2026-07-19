import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ThemeToggle } from '../components/ThemeToggle.tsx';
import { courseColor } from '../lib/color.ts';

// Cuando el repo sea público, poné la URL acá y los enlaces a GitHub aparecen
// solos en header, sección open source y footer.
const REPO_URL: string | null = null;

/* Aparece al entrar al viewport (una sola vez). El estado inicial oculto vive
   en CSS (.reveal), así que sin JS o con reduced-motion el contenido se ve. */
function Reveal({ children, className = '', delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          io.disconnect();
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`reveal ${visible ? 'is-visible' : ''} ${className}`}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}

/* El titular es la corrección misma: "micampus solution" tachado y enmendado a
   mano hasta leerse "mikampus BETTER solution". El tachón, la "k" y el sello
   entran en secuencia al cargar (ver index.css). */
function CorrectedWordmark() {
  return (
    <h1 className="font-display max-w-4xl text-[clamp(2.4rem,9vw,5.75rem)] leading-[1.06] font-semibold tracking-[-0.04em] text-balance">
      <span className="whitespace-nowrap">
        mi
        <span className="relative inline-block">
          <span aria-hidden="true">c</span>
          {/* Tachón: un trazo SVG que se dibuja sobre la "c". */}
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
          >
            <path
              className="hero-strike"
              d="M -0.15 0.72 C 0.25 0.6, 0.75 0.5, 1.2 0.38"
              pathLength={1}
              fill="none"
              stroke="var(--closed)"
              strokeWidth={4.5}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {/* La "k" enmendada arriba, en tinta roja. */}
          <span
            aria-hidden="true"
            className="hero-k text-closed absolute -top-[0.52em] left-1/2 -ml-[0.22em] text-[0.55em] font-semibold"
          >
            k
          </span>
        </span>
        ampus
      </span>{' '}
      <span className="relative inline-block align-baseline">
        <span
          aria-hidden="true"
          className="hero-caret text-closed absolute -bottom-[0.28em] left-1/2 -ml-[0.3em] text-[0.6em] font-semibold"
        >
          ‸
        </span>
        <span className="hero-stamp border-closed text-closed inline-block rounded-[var(--radius)] border-[3px] px-[0.14em] py-[0.02em] text-[0.82em] leading-none font-bold tracking-[0.02em]">
          BETTER
        </span>
      </span>{' '}
      <span className="whitespace-nowrap">solution</span>
      {/* Lo que lee un lector de pantalla: el resultado, no el chiste visual. */}
      <span className="sr-only">mikampus BETTER solution</span>
    </h1>
  );
}

function SectionHeading({ kicker, title }: { kicker: string; title: string }) {
  return (
    <div>
      <p className="text-muted text-xs font-medium tracking-[0.14em] uppercase">{kicker}</p>
      <h2 className="font-display mt-2 max-w-2xl text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-4xl">
        {title}
      </h2>
    </div>
  );
}

/* Fila de la evaluación: lo que hace el portal vs. lo que hace mikampus. */
function ReportRow({ concepto, ellos, nosotros }: { concepto: string; ellos: string; nosotros: string }) {
  return (
    <div className="border-line grid border-t sm:grid-cols-[10rem_1fr_1fr] sm:gap-6">
      <div className="text-muted pt-4 text-xs font-medium tracking-wide uppercase sm:py-5">{concepto}</div>
      <div className="text-muted pt-2 pb-1 text-sm leading-6 sm:py-5">
        <span className="text-closed sm:hidden">✗ </span>
        {ellos}
      </div>
      <div className="pt-1 pb-4 text-sm leading-6 sm:py-5">
        <span className="text-open">✓ </span>
        {nosotros}
      </div>
    </div>
  );
}

function MockSearch() {
  const results = [
    { code: 'ICC-223', title: 'Bases de Datos', estado: 'Abierta · 14 cupos', tone: 'text-open' },
    { code: 'ITE-326', title: 'Introducción Sistemas Digitales', estado: 'Abierta · 3 cupos', tone: 'text-open' },
    { code: '1ITE-326', title: 'Lab. ITE-326', estado: 'Lista de espera · 2', tone: 'text-waitlist' },
  ];
  return (
    <div aria-hidden="true" className="border-line bg-surface rounded-[calc(var(--radius)*1.5)] border p-4 select-none">
      <div className="border-line bg-surface-2 rounded-[var(--radius)] border px-3 py-2.5 font-mono text-sm">
        base de dato
        <span className="caret-blink">▍</span>
      </div>
      <ul className="mt-2">
        {results.map((r, i) => (
          <Reveal key={r.code} delay={i * 120}>
            <li className="border-line flex items-center gap-3 border-t px-1 py-2.5 text-sm first:border-t-0">
              <span className="size-2.5 shrink-0 rounded-sm" style={{ background: courseColor(r.code) }} />
              <span className="tabular font-mono text-xs">{r.code}</span>
              <span className="min-w-0 flex-1 truncate">{r.title}</span>
              <span className={`text-xs ${r.tone}`}>{r.estado}</span>
            </li>
          </Reveal>
        ))}
      </ul>
      <p className="text-muted mt-2 px-1 text-[11px]">3 resultados en 9ms · sin acentos, da igual</p>
    </div>
  );
}

function MockWeek() {
  const days: { day: string; blocks: { code: string; top: number; h: number }[] }[] = [
    { day: 'Lun', blocks: [{ code: 'ICC-223', top: 8, h: 22 }, { code: 'MAT-350', top: 46, h: 22 }] },
    { day: 'Mar', blocks: [{ code: 'ITE-326', top: 20, h: 30 }] },
    { day: 'Mié', blocks: [{ code: 'ICC-223', top: 8, h: 22 }, { code: 'FIL-201', top: 62, h: 22 }] },
    { day: 'Jue', blocks: [{ code: 'ITE-326', top: 20, h: 22 }, { code: '1ITE-326', top: 46, h: 30 }] },
    { day: 'Vie', blocks: [{ code: 'MAT-350', top: 30, h: 22 }] },
  ];
  return (
    <div aria-hidden="true" className="border-line bg-surface rounded-[calc(var(--radius)*1.5)] border p-4 select-none">
      <div className="grid grid-cols-5 gap-1.5">
        {days.map((d) => (
          <div key={d.day}>
            <div className="text-muted pb-1.5 text-center text-[10px] font-medium tracking-wide uppercase">{d.day}</div>
            <div className="bg-surface-2 relative h-44 rounded-[var(--radius)]">
              {d.blocks.map((b) => (
                <div
                  key={`${d.day}-${b.code}-${b.top}`}
                  className="absolute inset-x-0.5 flex items-start justify-center overflow-hidden rounded-[4px] pt-1"
                  style={{ top: `${b.top}%`, height: `${b.h}%`, background: courseColor(b.code) }}
                >
                  <span className="font-mono text-[8px] font-medium text-black/60">{b.code}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="text-muted mt-2.5 text-[11px]">Cada materia con su color, el mismo en toda la app.</p>
    </div>
  );
}

function MockLog() {
  const lines = [
    { t: '09:59:55', msg: 'esperando la ventana de inscripción…', tone: 'text-muted' },
    { t: '10:00:00', msg: 'abriendo carrito (4 materias)', tone: '' },
    { t: '10:00:03', msg: 'ICC-223 · sección 4567 — inscrita ✓', tone: 'text-open' },
    { t: '10:00:05', msg: 'ITE-326 · sección 2201 — inscrita ✓', tone: 'text-open' },
    { t: '10:00:06', msg: '1ITE-326 · lista de espera, posición 2', tone: 'text-waitlist' },
    { t: '10:00:07', msg: 'listo: 3/4 inscritas, reporte guardado', tone: '' },
  ];
  return (
    <Reveal>
      <div
        aria-hidden="true"
        className="border-line bg-surface rounded-[calc(var(--radius)*1.5)] border p-4 font-mono text-xs leading-6 select-none sm:text-[13px]"
      >
        <div className="text-muted flex items-center gap-1.5 pb-2">
          <span className="bg-open size-2 rounded-full" /> actividad en vivo
        </div>
        {lines.map((l, i) => (
          <div key={l.t} className="log-line flex gap-3" style={{ '--i': i } as React.CSSProperties}>
            <span className="text-muted tabular shrink-0">{l.t}</span>
            <span className={l.tone}>{l.msg}</span>
          </div>
        ))}
      </div>
    </Reveal>
  );
}

export function Landing() {
  return (
    <div className="min-h-full">
      {/* Header liviano: el CTA vive acá y en el hero, nada más compite. */}
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-5 py-4 sm:px-8">
        <span className="font-display text-lg font-semibold tracking-tight">mikampus</span>
        <nav className="flex items-center gap-2 sm:gap-4">
          <Link to="/docs" className="text-muted hover:text-fg text-sm transition-colors duration-100">
            Cómo funciona
          </Link>
          {REPO_URL && (
            <a href={REPO_URL} className="text-muted hover:text-fg text-sm transition-colors duration-100">
              GitHub
            </a>
          )}
          <ThemeToggle />
          <Link
            to="/entrar"
            className="bg-accent text-accent-fg rounded-[var(--radius)] px-3.5 py-2 text-sm font-medium"
          >
            Entrar
          </Link>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-6xl px-5 sm:px-8">
        {/* ---- Hero: la corrección --------------------------------------- */}
        <section className="flex min-h-[70svh] flex-col items-center justify-center py-16 text-center sm:py-20">
          <p className="hero-seq text-muted text-sm font-medium">
            para estudiantes PUCMM · código abierto
          </p>
          <div className="hero-seq mt-5" style={{ animationDelay: '150ms' }}>
            <CorrectedWordmark />
          </div>
          <p className="hero-seq text-muted mt-7 max-w-xl text-base leading-7" style={{ animationDelay: '300ms' }}>
            El portal de siempre sigue ahí abajo — mikampus se le sienta encima y hace el trabajo sucio: busca materias
            al instante, arma tu horario, se inscribe a la hora exacta y te muestra todo sin un solo spinner de
            PeopleSoft.
          </p>
          <div
            className="hero-seq mt-8 flex flex-wrap items-center justify-center gap-3"
            style={{ animationDelay: '400ms' }}
          >
            <Link
              to="/entrar"
              className="bg-accent text-accent-fg rounded-[var(--radius)] px-5 py-2.5 text-sm font-medium"
            >
              Entrar a mikampus
            </Link>
            <Link
              to="/docs"
              className="border-line hover:bg-surface rounded-[var(--radius)] border px-5 py-2.5 text-sm font-medium transition-colors duration-100"
            >
              Cómo funciona por dentro →
            </Link>
          </div>
          <p className="hero-seq text-muted mt-8 font-mono text-xs" style={{ animationDelay: '500ms' }}>
            0 iframes · 0 popups · 0 «su sesión ha expirado»
          </p>
        </section>

        {/* ---- La evaluación ---------------------------------------------- */}
        <section className="py-16 sm:py-24">
          <Reveal>
            <SectionHeading kicker="con cariño, pero con datos" title="Evaluación de medio término" />
          </Reveal>
          <Reveal delay={100}>
            <div className="border-line bg-surface mt-8 rounded-[calc(var(--radius)*1.5)] border px-5 sm:px-8">
              <div className="text-muted hidden py-4 text-xs font-medium tracking-wide uppercase sm:grid sm:grid-cols-[10rem_1fr_1fr] sm:gap-6">
                <span>concepto</span>
                <span>micampus solution</span>
                <span className="text-fg">mikampus BETTER solution</span>
              </div>
              <ReportRow
                concepto="Tu horario"
                ellos="menú Fluid → tile → iframe → esperar → otro clic."
                nosotros="es la pantalla de inicio. Carga desde SQLite, sin tocar el portal."
              />
              <ReportRow
                concepto="Buscar materias"
                ellos="máximo 50 resultados, sin paginación. En serio."
                nosotros="el catálogo entero en tu navegador, resultados mientras escribís."
              />
              <ReportRow
                concepto="La sesión"
                ellos="expiró mientras leías esta fila."
                nosotros="una sesión headless que se vuelve a loguear sola."
              />
              <ReportRow
                concepto="Inscripción"
                ellos="vos, F5, y dos mil estudiantes más a la misma hora."
                nosotros="programás la hora; el asistente corre puntual y te reporta cada paso."
              />
              <ReportRow
                concepto="Modo oscuro"
                ellos="el blanco PeopleSoft es parte de la experiencia."
                nosotros="sí — la pre-matrícula se programa de madrugada."
              />
              <div className="border-line grid border-t sm:grid-cols-[10rem_1fr_1fr] sm:gap-6">
                <div className="text-muted pt-4 text-xs font-medium tracking-wide uppercase sm:py-5">Nota final</div>
                <div className="text-closed pt-2 pb-1 font-mono text-sm sm:py-5">62/100 — puede mejorar</div>
                <div className="text-open pt-1 pb-4 font-mono text-sm sm:py-5">
                  98/100 <span className="text-muted">(y PUCMM promedia las repetidas: esta sube el índice)</span>
                </div>
              </div>
            </div>
          </Reveal>
        </section>

        {/* ---- Tres viñetas del producto ---------------------------------- */}
        <section className="space-y-20 py-8 sm:space-y-28 sm:py-16">
          <div className="grid items-center gap-8 lg:grid-cols-2 lg:gap-16">
            <Reveal>
              <SectionHeading kicker="búsqueda" title="Escribí y ya." />
              <p className="text-muted mt-4 max-w-md text-sm leading-7">
                El catálogo completo vive en tu navegador con un índice MiniSearch: resultados en menos de 16
                milisegundos, insensibles a acentos, con cupos al día. Sin límite de 50, sin botón «Search» de 1998.
              </p>
            </Reveal>
            <Reveal delay={120}>
              <MockSearch />
            </Reveal>
          </div>

          <div className="grid items-center gap-8 lg:grid-cols-2 lg:gap-16">
            <Reveal delay={120} className="lg:order-2">
              <SectionHeading kicker="horario" title="Tu semana, de un vistazo." />
              <p className="text-muted mt-4 max-w-md text-sm leading-7">
                Planner y builder arman el ciclo bloque por bloque, cada materia con un color estable en toda la app. Se
                exporta a tu calendario en .ics y se imprime en una hoja apaisada digna de nevera.
              </p>
            </Reveal>
            <Reveal className="lg:order-1">
              <MockWeek />
            </Reveal>
          </div>

          <div className="grid items-center gap-8 lg:grid-cols-2 lg:gap-16">
            <Reveal>
              <SectionHeading kicker="inscripción" title="A las 10:00:00, no a las 10:04." />
              <p className="text-muted mt-4 max-w-md text-sm leading-7">
                Programás tu hora de pre-matrícula y mikampus corre el asistente de inscripción por vos, materia por
                materia, reportando cada paso en vivo. Si un cupo se abre después, el watcher lo está mirando.
              </p>
            </Reveal>
            <MockLog />
          </div>
        </section>

        {/* ---- Y además --------------------------------------------------- */}
        <section className="py-16 sm:py-20">
          <Reveal>
            <SectionHeading kicker="lo demás" title="También hace lo aburrido, bien." />
          </Reveal>
          <Reveal delay={100}>
            <ul className="mt-8 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {[
                'Trayectoria y avance de carrera contra tu pensum',
                'Notas con proyección de índice (sí, promediando las repetidas)',
                'Detección de holds antes de que te arruinen la inscripción',
                'Planner de próximos ciclos con lo que te falta',
                'PWA instalable: abre standalone y sobrevive sin red',
                'Todo dato dice hace cuánto se sincronizó — nada finge estar fresco',
              ].map((item) => (
                <li key={item} className="border-line bg-surface rounded-[var(--radius)] border px-4 py-3 leading-6">
                  {item}
                </li>
              ))}
            </ul>
          </Reveal>
        </section>

        {/* ---- Open source ------------------------------------------------ */}
        <section className="py-16 sm:py-24">
          <Reveal>
            <div className="border-line bg-surface rounded-[calc(var(--radius)*1.5)] border p-7 sm:p-12">
              <p className="text-muted text-xs font-medium tracking-[0.14em] uppercase">código abierto</p>
              <h2 className="font-display mt-3 max-w-2xl text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-5xl">
                Abierto hasta las trampas de PeopleSoft.
              </h2>
              <p className="text-muted mt-5 max-w-xl text-sm leading-7">
                Todo el scraping, los parsers y sus tests contra HTML real del portal son públicos. Podés correr
                mikampus completo en tu propia máquina, con tus credenciales — que nunca salen de ahí. La documentación
                explica cada pieza, incluyendo por qué el catálogo necesita dos pantallas del portal y qué significa
                «1ITE326».
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <Link
                  to="/docs"
                  className="bg-accent text-accent-fg rounded-[var(--radius)] px-5 py-2.5 text-sm font-medium"
                >
                  Leer la documentación
                </Link>
                {REPO_URL && (
                  <a
                    href={REPO_URL}
                    className="border-line hover:bg-surface-2 rounded-[var(--radius)] border px-5 py-2.5 text-sm font-medium transition-colors duration-100"
                  >
                    Ver en GitHub
                  </a>
                )}
              </div>
            </div>
          </Reveal>
        </section>
      </main>

      <footer className="border-line border-t">
        <div className="text-muted mx-auto flex w-full max-w-6xl flex-col gap-4 px-5 py-8 text-xs leading-6 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <p className="max-w-md">
            mikampus no está afiliado a la PUCMM ni a Oracle® PeopleSoft. «micampus solution» es de sus respectivos
            dueños; el chiste es nuestro. Beta por invitación: usás tu cuenta normal del portal, no creamos otra.
          </p>
          <nav className="flex shrink-0 gap-4">
            <Link to="/docs" className="hover:text-fg transition-colors duration-100">
              Documentación
            </Link>
            {REPO_URL && (
              <a href={REPO_URL} className="hover:text-fg transition-colors duration-100">
                GitHub
              </a>
            )}
            <Link to="/entrar" className="hover:text-fg transition-colors duration-100">
              Entrar
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
