# pucmm-autoenroll → mikampus

Plataforma local que reemplaza el día a día de micampus.pucmm.edu.do: buscar materias, armar horario, planificar ciclos, inscribirse y ver notas/avance, desde una interfaz propia rápida. PeopleSoft queda como backend invisible al que se le hace scraping vía Playwright. El plan completo está en [`PLAN.md`](./PLAN.md).

Hoy funciona:

1. **Buscar materias** — un input, resultados instantáneos del catálogo cacheado (índice MiniSearch en el cliente, insensible a acentos).
2. **Carrito e inscripción** — carrito en vivo, hora fija de pre-matrícula, watcher de cupos e inscripción manual.
3. **Actividad en vivo** — cada operación Playwright reporta su progreso por SSE.

Todo corre sobre una única sesión de Playwright (headless) que el backend mantiene y re-loguea sola si expira. Los datos estables (catálogo) viven en SQLite y se sirven desde disco; solo lo volátil (cupos, carrito) va en vivo.

## Setup

```bash
npm install
npm run install-browsers   # descarga Chromium para Playwright
cp .env.example .env       # completa PUCMM_USERNAME y PUCMM_PASSWORD
npm run build              # compila la SPA (web/ → public/dist)
npm start                  # levanta mikampus en http://localhost:4173
```

Abrí `http://localhost:4173`. Para desarrollar el frontend con hot-reload: `npm run dev` (Vite en :5173 con proxy de `/api` al backend en :4173, que debe estar corriendo con `npm start`).

Sin catálogo real todavía, sembrá datos de prueba para ver la búsqueda: `node scripts/seed-catalog.mjs`.

## Stack

- **Backend** — Node + Express, Playwright para el scraping, `node:sqlite` (built-in, sin compilación nativa) para el catálogo y los planes en `data/mikampus.db`.
- **Frontend** — Vite + React + TypeScript + Tailwind v4, TanStack Query (stale-while-revalidate), React Router, MiniSearch. SPA en `web/`, build servido por el mismo Express.
- **Contratos** — Zod en `src/shared/schemas.ts`, importado tal cual por backend (TS nativo de Node) y frontend: todo output de scraper se valida en el borde.

## Verificación (gate de cada fase)

```bash
npm test                                         # parsers + DB + grid + ICS, sin tocar el portal
npm run build && node scripts/check-budget.mjs   # bundle inicial < 250KB gz
node scripts/bench-search.mjs                    # keystroke → resultados < 16ms
npm run smoke                                    # screenshots a 390/768/1440px + falla si hay desborde horizontal
```

`npm test` corre los parsers contra HTML real volcado del portal y guardado en
`fixtures/` (sin tokens ni datos personales — ver `scripts/make-fixture.mjs`).
Es la red de los selectores: PeopleSoft cambia IDs entre parches y esto falla
antes que un barrido en vivo. Para regenerar un fixture:

```bash
npm run recon:catalog                            # RECON_PREFIX=ICC3 acota la búsqueda
npm run recon:schedule
node scripts/make-fixture.mjs screenshots/recon-schedule-list.html
```

## Cómo funciona por dentro

- `src/login.js` — login contra el signon real de PUCMM.
- `src/session.js` — una sola sesión compartida, en fila (nunca dos acciones de Playwright en paralelo), con reintento de login si expira.
- `src/peoplesoft/cart.js` — lee el carrito y el estado (Open/Closed/Wait List) de cada materia.
- `src/peoplesoft/enroll.js` — corre el asistente de inscripción (Step 1→2→3) sobre todo el carrito y reporta éxito/error por materia.
- `src/peoplesoft/classSearch.js` — busca clases por término/carrera/código y las agrega al carrito, incluyendo los pasos intermedios que PeopleSoft pida (sección relacionada, preferencias de inscripción).
- `src/scheduler.js` — programación a hora fija + watcher periódico, con notificaciones de escritorio (`notify-send`).
- `src/peoplesoft/catalog.js` — lee/escribe el catálogo en SQLite y barre el class search de un término. `GET /api/catalog` lo sirve cacheado con ETag. El portal corta en 50 secciones por búsqueda y no pagina, así que el barrido trocea por prefijo de `catalog_nbr` y subdivide cuando un trozo excede.
- `src/peoplesoft/mySchedule.js` — horario inscrito. `GET /api/my-schedule` lo sirve desde SQLite (no dispara scraping); el refresh en vivo es `POST /api/my-schedule/sync`. Ojo: `/api/schedule` es otra cosa, el scheduler de inscripción.
- `src/db.js` — SQLite (`node:sqlite`): catálogo, secciones, snapshots de cupo, inscripciones, planes, notas, holds y `sync_log`.
- `src/server.js` — API REST, SSE de actividad en vivo, y sirve la SPA compilada (`public/dist`) con fallback de ruteo.
- `web/` — la SPA React (rutas, componentes transversales `CourseChip`/`SeatBadge`/`StalenessTag`/`LiveOpBanner`/`WeeklyGrid`, sistema de diseño).

### De dónde sale el nombre de cada materia

El class search **no devuelve el título ni los créditos** de la materia: su
header viene como `ICC     ICC321 - ` con el título vacío. Por eso la tabla
`courses` es el diccionario código→título de la app, y lo llenan otras fuentes
(hoy Mi Horario, que sí los trae; mañana notas y avance). La regla que sostiene
todo esto: **un barrido de catálogo nunca puede pisar un título real con un
placeholder** — está cubierto por `scripts/test-catalog-db.mjs`.

## Riesgos a tener en cuenta

- **Credenciales**: quedan solo en tu `.env` local (gitignored). Nunca las compartas ni las subas a un repo — así fue como le robaron los cupos a un estudiante de Stevens Institute en 2019 al compartir su script con las credenciales adentro.
- **Política institucional**: varias universidades consideran estos bots una forma de saltarse el proceso de inscripción frente a otros estudiantes y han introducido límites de intentos de login o monitoreo tras detectarlos. Vale la pena revisar el reglamento de PUCMM antes de dejarlo corriendo en producción.
- **No sumar carga en el pico**: el intervalo de polling del watcher no debe bajar de los ~30-45s durante la ventana de alta demanda.
- **Selección de sección relacionada**: si una materia tiene varias secciones de práctico disponibles, `addClassToCart` elige la primera que encuentra — no hay todavía forma de elegir manualmente cuál.
