import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ThemeToggle } from '../components/ThemeToggle.tsx';

// Misma constante que en Landing: cuando el repo sea público, los enlaces
// a GitHub aparecen solos.
const REPO_URL: string | null = null;

const TOC = [
  { id: 'que-es', label: 'Qué es mikampus' },
  { id: 'arquitectura', label: 'La arquitectura' },
  { id: 'flujo', label: 'El flujo, paso a paso' },
  { id: 'stack', label: 'Stack y por qué' },
  { id: 'repo', label: 'Mapa del repositorio' },
  { id: 'setup', label: 'Correlo en tu máquina' },
  { id: 'peoplesoft', label: 'Las trampas de PeopleSoft' },
  { id: 'seguridad', label: 'Credenciales y seguridad' },
  { id: 'contribuir', label: 'Contribuir' },
] as const;

function Code({ children }: { children: string }) {
  return (
    <pre className="border-line bg-surface-2 tabular mt-4 overflow-x-auto rounded-[var(--radius)] border px-4 py-3 font-mono text-[13px] leading-6">
      {children}
    </pre>
  );
}

function K({ children }: { children: ReactNode }) {
  return <code className="bg-surface-2 rounded px-1.5 py-0.5 font-mono text-[0.85em]">{children}</code>;
}

function P({ children }: { children: ReactNode }) {
  return <p className="text-muted mt-4 max-w-2xl text-[15px] leading-7 first:mt-0">{children}</p>;
}

function H3({ children }: { children: ReactNode }) {
  return <h3 className="font-display mt-8 text-lg font-semibold tracking-tight">{children}</h3>;
}

function Section({ id, kicker, title, children }: { id: string; kicker: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 py-10 first:pt-0 sm:py-12">
      <p className="text-muted text-xs font-medium tracking-[0.14em] uppercase">{kicker}</p>
      <h2 className="font-display mt-2 text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">{title}</h2>
      <div className="mt-5">{children}</div>
    </section>
  );
}

/* Paso numerado del flujo: acá los números sí significan orden real. */
function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="relative pl-12">
      <span className="border-line bg-surface tabular absolute top-0.5 left-0 flex size-8 items-center justify-center rounded-full border font-mono text-sm font-medium">
        {n}
      </span>
      <h3 className="font-display pt-1 text-lg font-semibold tracking-tight">{title}</h3>
      <div className="mt-2">{children}</div>
    </li>
  );
}

function DiagramBox({ title, sub, tone = '' }: { title: string; sub: string; tone?: string }) {
  return (
    <div className={`border-line bg-surface rounded-[var(--radius)] border px-4 py-3 text-center ${tone}`}>
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted mt-0.5 text-xs leading-5">{sub}</p>
    </div>
  );
}

function DiagramArrow({ label }: { label: string }) {
  return (
    <div className="text-muted flex flex-col items-center py-1 font-mono text-[11px]">
      <span>{label}</span>
      <span aria-hidden="true">↓ ↑</span>
    </div>
  );
}

export function Docs() {
  const [active, setActive] = useState<string>(TOC[0].id);

  // Scrollspy: la sección visible más cercana al tope manda en el índice.
  useEffect(() => {
    const sections = TOC.map((t) => document.getElementById(t.id)).filter((el): el is HTMLElement => el != null);
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id);
        }
      },
      // Banda angosta cerca del tope: la sección que la cruza es "la actual".
      { rootMargin: '-15% 0px -75% 0px' }
    );
    for (const el of sections) io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div className="min-h-full">
      <header className="border-line bg-bg sticky top-0 z-10 border-b">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-5 py-3.5 sm:px-8">
          <div className="flex items-baseline gap-3">
            <Link to="/" className="font-display text-lg font-semibold tracking-tight">
              mikampus
            </Link>
            <span className="text-muted text-sm">documentación</span>
          </div>
          <nav className="flex items-center gap-2 sm:gap-4">
            {REPO_URL && (
              <a href={REPO_URL} className="text-muted hover:text-fg text-sm transition-colors duration-100">
                GitHub
              </a>
            )}
            <ThemeToggle />
            <Link to="/entrar" className="bg-accent text-accent-fg rounded-[var(--radius)] px-3.5 py-2 text-sm font-medium">
              Entrar
            </Link>
          </nav>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-6xl gap-10 px-5 py-10 sm:px-8 lg:grid-cols-[15rem_minmax(0,1fr)]">
        {/* Índice: sticky en desktop, plegable en mobile. */}
        <aside className="lg:pt-1">
          <details className="border-line bg-surface rounded-[var(--radius)] border px-4 py-3 lg:hidden">
            <summary className="cursor-pointer text-sm font-medium">Contenido</summary>
            <nav className="mt-3 flex flex-col gap-1">
              {TOC.map((t) => (
                <a key={t.id} href={`#${t.id}`} className="text-muted hover:text-fg py-1 text-sm">
                  {t.label}
                </a>
              ))}
            </nav>
          </details>
          <nav className="sticky top-20 hidden flex-col gap-0.5 lg:flex">
            {TOC.map((t) => (
              <a
                key={t.id}
                href={`#${t.id}`}
                className={`rounded-[var(--radius)] px-3 py-1.5 text-sm transition-colors duration-100 ${
                  active === t.id ? 'bg-surface-2 text-fg font-medium' : 'text-muted hover:text-fg'
                }`}
              >
                {t.label}
              </a>
            ))}
          </nav>
        </aside>

        <article className="min-w-0 pb-16">
          <Section id="que-es" kicker="empezá por acá" title="Qué es mikampus">
            <P>
              <strong className="text-fg">micampus solution</strong> es el nombre real del portal PeopleSoft de la
              PUCMM. <strong className="text-fg">mikampus</strong> (BETTER solution) es este proyecto: una interfaz
              propia, rápida y de código abierto que reemplaza el día a día del portal — buscar materias, armar el
              horario, planificar ciclos, inscribirse y ver notas y avance — sin que tengas que abrir un iframe nunca
              más.
            </P>
            <P>
              El truco no es reemplazar al portal sino <em>esconderlo</em>: PeopleSoft sigue siendo la fuente de verdad
              institucional, pero queda como un backend invisible al que un navegador automatizado (Playwright) le
              habla por vos. mikampus guarda lo estable en SQLite y solo va al portal cuando hace falta algo vivo:
              cupos, carrito, una inscripción.
            </P>
            <P>
              Es un proyecto de estudiante para estudiantes, sin afiliación con la PUCMM ni con Oracle. Nada de lo que
              hace mikampus altera tu expediente más de lo que lo haría hacer clic vos en el portal: usa exactamente
              las mismas pantallas, solo que sin sufrimiento.
            </P>
          </Section>

          <Section id="arquitectura" kicker="el dibujo completo" title="La arquitectura">
            <P>Cuatro piezas, apiladas. Todo lo demás son detalles de estas cuatro:</P>
            <div className="mt-6 max-w-md">
              <DiagramBox title="Tu navegador" sub="React SPA · índice de búsqueda MiniSearch · TanStack Query" />
              <DiagramArrow label="HTTP + SSE (actividad en vivo)" />
              <DiagramBox title="Express API" sub="Node.js · valida todo con Zod en el borde · sesión por cookie + CSRF" />
              <div className="mt-2 grid grid-cols-2 gap-2">
                <DiagramBox title="SQLite" sub="node:sqlite — catálogo, horario, notas, planes. Lectura instantánea." />
                <DiagramBox title="Playwright" sub="Chromium headless — una sola operación a la vez, en fila." />
              </div>
              <DiagramArrow label="scraping (solo cuando hace falta)" />
              <DiagramBox title="micampus (PeopleSoft)" sub="el portal real de PUCMM — la fuente de verdad institucional" />
            </div>
            <H3>Los principios que sostienen el dibujo</H3>
            <ul className="text-muted mt-3 max-w-2xl space-y-3 text-[15px] leading-7">
              <li>
                <strong className="text-fg">Entrar nunca espera a PeopleSoft.</strong> Toda pantalla lee SQLite primero
                y se muestra al instante; lo vencido se refresca en background después de montar la app.
              </li>
              <li>
                <strong className="text-fg">Todo dato dice su edad.</strong> Cada respuesta lleva su{' '}
                <K>syncedAt</K> y la interfaz lo muestra. Nada finge estar fresco: un horario de ayer se presenta como
                un horario de ayer.
              </li>
              <li>
                <strong className="text-fg">Una operación Playwright a la vez.</strong> Las acciones contra el portal
                van en fila; nunca dos scrapings en paralelo peleándose por la misma sesión.
              </li>
              <li>
                <strong className="text-fg">Todo output de scraper se valida en el borde.</strong> Los schemas Zod de{' '}
                <K>src/shared/schemas.ts</K> los importan tal cual backend y frontend; si PeopleSoft devuelve algo
                inesperado, explota en la frontera y no en tu horario.
              </li>
            </ul>
          </Section>

          <Section id="flujo" kicker="de tu clic al portal y de vuelta" title="El flujo, paso a paso">
            <ol className="mt-2 space-y-10">
              <Step n={1} title="Entrás con tu cuenta de siempre">
                <P>
                  El login no inventa una cuenta nueva: Playwright abre el signon real de la PUCMM y verifica tus
                  credenciales contra el portal (<K>src/login.js</K>, <K>src/auth.js</K>). Si pasan, mikampus te da una
                  sesión propia por cookie con protección CSRF. Cada usuario tiene su propio contexto de navegador en
                  un pool, con reintento consciente de sesión: si el portal la expira, se vuelve a loguear solo y
                  repite la operación.
                </P>
              </Step>
              <Step n={2} title="El catálogo se sincroniza a SQLite">
                <P>
                  Un barrido lee el Class Search del portal término por término y guarda materias, secciones, horarios
                  y cupos en SQLite (<K>src/peoplesoft/catalog.js</K>). No es un fetch inocente: el portal corta en 50
                  secciones por búsqueda y no pagina, así que el barrido trocea por prefijo de código y subdivide
                  cuando un trozo excede. Los títulos salen de otra pantalla (Browse Course Catalog) y se unen por el
                  código canónico — más sobre ese lío en{' '}
                  <a href="#peoplesoft" className="text-accent hover:underline">
                    las trampas de PeopleSoft
                  </a>
                  .
                </P>
              </Step>
              <Step n={3} title="Buscás sin tocar el portal">
                <P>
                  <K>GET /api/catalog</K> sirve el catálogo cacheado con ETag y el cliente arma un índice MiniSearch en
                  memoria: resultados en menos de 16 milisegundos por tecla, insensibles a acentos. La búsqueda jamás
                  dispara scraping — el portal ni se entera de que estás mirando.
                </P>
              </Step>
              <Step n={4} title="Armás el horario">
                <P>
                  Planner y builder colocan secciones en la grilla semanal; cada materia recibe un color estable
                  derivado de su código (hash → 14 matices OKLCH equidistantes), el mismo en búsqueda, planner, horario
                  y carrito. El horario inscrito se sirve desde SQLite, se exporta a <K>.ics</K> y tiene vista de
                  impresión apaisada.
                </P>
              </Step>
              <Step n={5} title="Te inscribís — o lo hace el asistente">
                <P>
                  La inscripción corre el asistente real del portal (Step 1 → 2 → 3) sobre todo el carrito
                  (<K>src/peoplesoft/enroll.js</K>), incluyendo los pasos intermedios que PeopleSoft pida: sección
                  relacionada, preferencias de inscripción. Cada materia reporta éxito, error o lista de espera por
                  separado, y todo el progreso se transmite en vivo por SSE — lo que ves en el feed de actividad es el
                  navegador headless trabajando en ese momento.
                </P>
              </Step>
              <Step n={6} title="El scheduler vigila por vos">
                <P>
                  Podés programar la inscripción a hora fija (la ventana de pre-matrícula) y activar un watcher de
                  cupos que revisa periódicamente — nunca más agresivo que ~30-45 segundos en la ventana de alta
                  demanda, para no sumar carga en el pico (<K>src/scheduler.js</K>). Los timers se persisten por
                  usuario y cada acción queda en un <K>action_log</K> auditable.
                </P>
              </Step>
              <Step n={7} title="Los datos se mantienen frescos sin molestar">
                <P>
                  La app entera es stale-while-revalidate: se muestra lo cacheado al instante y se refresca lo vencido
                  en background. El service worker de la PWA cachea el shell pero <strong className="text-fg">nunca</strong>{' '}
                  <K>/api</K> — un cache invisible sin fecha te mostraría el horario de ayer diciendo «actualizado hace
                  instantes», que es exactamente el tipo de mentira que mikampus no dice.
                </P>
              </Step>
            </ol>
          </Section>

          <Section id="stack" kicker="las herramientas y sus porqués" title="Stack y por qué">
            <P>Cada pieza está elegida para que el proyecto sea clonable sin fricción: sin compilación nativa, sin servicios externos, sin pasos mágicos.</P>
            <div className="border-line mt-6 overflow-x-auto rounded-[calc(var(--radius)*1.5)] border">
              <table className="w-full min-w-[36rem] text-left text-sm">
                <thead>
                  <tr className="border-line bg-surface text-muted border-b text-xs uppercase">
                    <th className="px-4 py-3 font-medium">pieza</th>
                    <th className="px-4 py-3 font-medium">qué hace</th>
                    <th className="px-4 py-3 font-medium">por qué esta y no otra</th>
                  </tr>
                </thead>
                <tbody className="align-top">
                  {[
                    ['Node + Express', 'API REST, SSE y sirve la SPA compilada', 'un solo proceso para todo; cero infraestructura'],
                    ['Playwright', 'el navegador headless que opera el portal', 'PeopleSoft es JS pesado con iframes; scraping HTTP puro no sobrevive'],
                    ['node:sqlite', 'catálogo, horario, notas, planes, logs', 'built-in de Node: sin compilación nativa, npm install nunca falla por esto'],
                    ['TypeScript nativo de Node', 'los contratos compartidos en src/shared/', 'backend y frontend importan el mismo schema sin paso de build'],
                    ['Zod', 'valida todo output de scraper en el borde', 'PeopleSoft cambia sin avisar; mejor explotar en la frontera que en la UI'],
                    ['Vite + React 19', 'la SPA en web/', 'hot-reload rápido; bundle inicial presupuestado en <250KB gz'],
                    ['Tailwind v4', 'sistema de diseño por tokens CSS', 'modo oscuro por clase y tokens intercambiables en runtime'],
                    ['TanStack Query', 'stale-while-revalidate en toda la app', 'la política de frescura es el producto, no un extra'],
                    ['MiniSearch', 'índice de búsqueda en el cliente', 'el catálogo entero cabe en memoria; buscar no debe tocar la red'],
                    ['SSE', 'actividad en vivo del scraping', 'unidireccional alcanza, y pasa por cualquier proxy sin ceremonia'],
                  ].map(([pieza, que, por]) => (
                    <tr key={pieza} className="border-line border-b last:border-b-0">
                      <td className="text-fg px-4 py-3 font-mono text-xs whitespace-nowrap">{pieza}</td>
                      <td className="text-muted px-4 py-3 leading-6">{que}</td>
                      <td className="text-muted px-4 py-3 leading-6">{por}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section id="repo" kicker="dónde vive cada cosa" title="Mapa del repositorio">
            <Code>{`├── src/                  el backend
│   ├── server.js         API REST + SSE + sirve la SPA compilada
│   ├── login.js          login contra el signon real de PUCMM
│   ├── session.js        pool de sesiones Playwright, en fila, con re-login
│   ├── scheduler.js      hora fija de inscripción + watcher de cupos
│   ├── db.js             SQLite: catálogo, horario, notas, planes, logs
│   ├── shared/           contratos Zod + código canónico de materia
│   │                     (importados tal cual por backend y frontend)
│   └── peoplesoft/       un scraper por pantalla del portal
│       ├── classSearch.js  buscar clases y agregarlas al carrito
│       ├── catalog.js      barrido del catálogo → SQLite
│       ├── cart.js         leer carrito y estado de cupos
│       ├── enroll.js       el asistente de inscripción Step 1→2→3
│       └── mySchedule.js   el horario inscrito
├── web/                  la SPA React (rutas, componentes, diseño)
├── scripts/              tests, sync del catálogo, fixtures, budgets
├── fixtures/             HTML real del portal, anonimizado — la red
│                         de seguridad de todos los parsers
└── docs/                 procedimientos operativos (deploy, validación)`}</Code>
            <P>
              La regla de oro del repo: los parsers nunca se testean contra el portal vivo. <K>fixtures/</K> guarda
              HTML real volcado y anonimizado, y <K>npm test</K> corre todos los parsers contra eso. Cuando PeopleSoft
              cambia IDs en un parche, falla un test antes que un barrido en producción.
            </P>
          </Section>

          <Section id="setup" kicker="cinco minutos, cero magia" title="Correlo en tu máquina">
            <P>Necesitás Node 22+ y una cuenta del portal. Nada más.</P>
            <Code>{`git clone <el-repo> && cd mikampus
npm install
npm run install-browsers   # descarga Chromium para Playwright
cp .env.example .env
npm run build              # compila la SPA (web/ → public/dist)
npm start                  # mikampus en http://localhost:4173`}</Code>
            <P>
              Para que la búsqueda tenga contra qué buscar, llená el catálogo desde el portal (una vez por término;
              tarda unos minutos por carrera):
            </P>
            <Code>{`node scripts/sync-catalog.mjs --subjects   # la lista de carreras (~3 min)
node scripts/sync-catalog.mjs ICC MAT      # títulos + secciones por carrera`}</Code>
            <P>
              Para desarrollar el frontend con hot-reload: <K>npm run dev</K> levanta Vite en :5173 con proxy de{' '}
              <K>/api</K> al backend en :4173 (que debe estar corriendo con <K>npm start</K>). En localhost, mikampus
              se instala como PWA. El agente Desktop no abre la LAN: el acceso remoto requiere el modo Home Server,
              con túnel SSH o HTTPS explícito.
            </P>
            <P>
              No existe un modo hosted ni multiusuario: tus credenciales y datos permanecen en el hardware que
              controlás.
            </P>
          </Section>

          <Section id="peoplesoft" kicker="lo que nadie te cuenta del portal" title="Las trampas de PeopleSoft">
            <P>
              Esta sección existe porque es el conocimiento más caro del proyecto: cada punto costó horas de recon
              contra el portal real. Si vas a contribuir, leela dos veces.
            </P>
            <H3>El catálogo necesita dos pantallas</H3>
            <P>
              El Class Search da secciones, horarios y cupos, pero <em>no</em> el título de la materia: su header viene
              como <K>ICC&nbsp;&nbsp;&nbsp;ICC321 -&nbsp;</K> con el título vacío. El Browse Course Catalog da lo
              contrario: títulos y lista de carreras, sin secciones. Las dos escriben en la misma tabla y se unen por
              el código canónico — y un barrido nunca puede pisar un título real con un placeholder.
            </P>
            <H3>El límite de 50, sin paginación</H3>
            <P>
              El Class Search corta en 50 secciones por búsqueda y no ofrece página 2. El barrido del catálogo trocea
              por prefijo de código (<K>ICC1</K>, <K>ICC2</K>, …) y subdivide recursivamente cuando un trozo excede el
              límite.
            </P>
            <H3>Los códigos vienen sucios</H3>
            <div className="border-line mt-4 overflow-x-auto rounded-[calc(var(--radius)*1.5)] border">
              <table className="w-full min-w-[32rem] text-left text-sm">
                <thead>
                  <tr className="border-line bg-surface text-muted border-b text-xs uppercase">
                    <th className="px-4 py-3 font-medium">código</th>
                    <th className="px-4 py-3 font-medium">qué es</th>
                    <th className="px-4 py-3 font-medium">la trampa</th>
                  </tr>
                </thead>
                <tbody className="align-top">
                  {[
                    ['ICC223', 'Bases de Datos', 'el caso normal: carrera pegada al número'],
                    ['ICCE01', 'Electiva de ICC', 'el «número» lleva letras'],
                    ['ITE326', 'Intro. Sistemas Digitales', 'aparece listado bajo ICC, pero es de ITE'],
                    ['1ITE326', 'Lab. ITE-326', 'el dígito de delante es otra materia, no una variante'],
                  ].map(([code, que, trampa]) => (
                    <tr key={code} className="border-line border-b last:border-b-0">
                      <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">{code}</td>
                      <td className="text-muted px-4 py-3 leading-6">{que}</td>
                      <td className="text-muted px-4 py-3 leading-6">{trampa}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <P>
              Por eso la normalización vive en un solo lugar (<K>src/shared/courseCode.ts</K>) y no dentro de cada
              parser: la carrera se deriva del código y nunca del grupo donde apareció, y el dígito de prefijo se
              conserva — quitarlo fusionaba el laboratorio con su teoría.
            </P>
            <H3>La sesión expira cuando quiere</H3>
            <P>
              Toda operación asume que la sesión puede estar muerta al empezar. El pool de sesiones detecta el
              redirect al signon, se vuelve a loguear y reintenta la operación una vez — por eso las operaciones son
              idempotentes o verifican estado antes de actuar.
            </P>
            <H3>Los IDs cambian entre parches</H3>
            <P>
              Oracle actualiza el portal y los IDs de elementos cambian. La defensa no es heroísmo en los selectores
              sino los fixtures: HTML real congelado en <K>fixtures/</K> y parsers testeados contra eso en cada{' '}
              <K>npm test</K>.
            </P>
          </Section>

          <Section id="seguridad" kicker="lo serio" title="Credenciales y seguridad">
            <ul className="text-muted mt-2 max-w-2xl space-y-3 text-[15px] leading-7">
              <li>
                <strong className="text-fg">Tus credenciales no salen de tu máquina.</strong> Se ingresan para la
                sesión local y solo las usa el Playwright que se loguea al portal por vos.
              </li>
              <li>
                <strong className="text-fg">La contraseña sirve para tu sesión y no se guarda de forma permanente.</strong>{' '}
                Solo si activás funciones programadas (inscripción a hora fija) mikampus pide consentimiento aparte
                para guardar una credencial cifrada, con fecha de vencimiento atada a la ventana de inscripción — se
                destruye sola después.
              </li>
              <li>
                <strong className="text-fg">Nunca compartas un script con tus credenciales adentro.</strong> Así fue
                como a un estudiante del Stevens Institute le robaron los cupos en 2019. El diseño entero de mikampus
                existe para que eso no pueda pasarte.
              </li>
              <li>
                <strong className="text-fg">No sumar carga en el pico.</strong> El watcher de cupos no baja de ~30-45
                segundos en la ventana de alta demanda. mikampus hace lo que harías vos a mano, no un ataque de F5.
              </li>
              <li>
                <strong className="text-fg">Revisá el reglamento.</strong> Varias universidades consideran los bots de
                inscripción una forma de saltarse el proceso y han respondido con límites de login o monitoreo. Leé la
                política de la PUCMM antes de dejar el scheduler corriendo en producción. mikampus es una herramienta;
                usarla con juicio es tu parte.
              </li>
            </ul>
          </Section>

          <Section id="contribuir" kicker="rompé algo, con red" title="Contribuir">
            <P>El proyecto tiene tres redes de seguridad, y las tres corren sin tocar el portal:</P>
            <Code>{`npm test                                       # parsers + DB + grid + ICS contra fixtures
npm run build && node scripts/check-budget.mjs # bundle inicial < 250KB gz
npm run smoke                                  # screenshots 390/768/1440px, falla si algo desborda`}</Code>
            <P>
              Si un cambio tuyo necesita HTML nuevo del portal, no lo pegues a mano: los scripts de recon (
              <K>npm run recon:catalog</K>, <K>recon:schedule</K>, …) vuelcan la pantalla real y{' '}
              <K>scripts/make-fixture.mjs</K> la anonimiza — sin tokens ni datos personales — antes de guardarla en{' '}
              <K>fixtures/</K>.
            </P>
            <P>
              Buenos primeros aportes: un parser para una pantalla del portal aún sin scrapear, elegir manualmente la
              sección de laboratorio (hoy <K>addClassToCart</K> toma la primera disponible), o cualquier trampa nueva
              de PeopleSoft que descubras — documentala en la sección de arriba, que para eso está.
            </P>
            {REPO_URL && (
              <a
                href={REPO_URL}
                className="bg-accent text-accent-fg mt-6 inline-block rounded-[var(--radius)] px-5 py-2.5 text-sm font-medium"
              >
                Ver el repositorio en GitHub
              </a>
            )}
          </Section>

          <footer className="border-line text-muted border-t pt-6 text-xs leading-6">
            mikampus no está afiliado a la PUCMM ni a Oracle® PeopleSoft.{' '}
            <Link to="/" className="hover:text-fg underline">
              Volver al inicio
            </Link>
          </footer>
        </article>
      </div>
    </div>
  );
}
