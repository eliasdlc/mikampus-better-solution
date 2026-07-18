# pucmm-autoenroll → mikampus

Plataforma local que reemplaza el día a día de micampus.pucmm.edu.do: buscar materias, armar horario, planificar ciclos, inscribirse y ver notas/avance, desde una interfaz propia rápida. PeopleSoft queda como backend invisible al que se le hace scraping vía Playwright. El plan implementado hasta hoy está en [`PLAN.md`](./PLAN.md); la visión de reemplazo total y su matriz de paridad están en [`PLAN-MIKAMPUS-TOTAL.md`](./PLAN-MIKAMPUS-TOTAL.md).

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

### Desde el teléfono

`HOST=0.0.0.0 npm start` lo abre a tu red local e imprime la URL a tipear en el teléfono (`http://192.168.x.x:4173`). Tus credenciales no salen de tu máquina — el `.env` y la sesión de Playwright siguen acá— **pero la app queda al alcance de todo el WiFi y no tiene login**: quien la abra usa tu sesión del portal y puede inscribir o dar de baja en tu nombre. En tu casa es razonable; en el WiFi de la universidad, no. Por eso el default es solo `localhost`.

En localhost, mikampus se instala como PWA (manifest + service worker: abre standalone y el shell sobrevive sin red). Por LAN plana no: `http://192.168.x.x` no es contexto seguro y el navegador no registra service workers ahí, así que desde el teléfono es una web normal — funciona igual, pero sin instalar. El service worker cachea el shell y **nunca** `/api`: los datos vienen con su `syncedAt` y un cache invisible sin fecha te mostraría el horario de ayer diciendo "actualizado hace instantes".

Para que la búsqueda tenga contra qué buscar, llená el catálogo desde el portal: `node scripts/sync-catalog.mjs ICC` (ver [De dónde sale el nombre de cada materia](#de-dónde-sale-el-nombre-de-cada-materia)). Tarda unos minutos por subject y solo hace falta una vez por término. `scripts/seed-catalog.mjs` siembra 4 materias **inventadas** y es solo para probar la UI sin portal — no lo corras contra la base real.

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

El catálogo son **dos pantallas del portal**, y ninguna alcanza sola:

- **Class Search** da secciones, horarios y cupos, pero no el título: su header
  viene como `ICC     ICC321 - ` con el título vacío.
- **Browse Course Catalog** (`SSS_BROWSE_CATLG`, la pestaña hermana en la misma
  carpeta) da lo contrario: la lista de subjects y el título de cada materia
  (`ICC223` → "Bases de Datos"), sin secciones. No tiene el límite de 50 porque
  lista materias, no secciones.

Las dos escriben en `courses` y se unen por el **código canónico** (`ICC-223`).
Que ese código salga idéntico de las dos es lo único que hace que el join
funcione, así que la regla vive en un solo lugar, `src/shared/courseCode.ts`, y
no dentro de cada parser. No es trivial, porque el catálogo real de PUCMM trae:

| Código    | Qué es                          | Trampa                                              |
|-----------|---------------------------------|-----------------------------------------------------|
| `ICC223`  | Bases de Datos                  | el caso normal: el subject va pegado al número      |
| `ICCE01`  | Electiva de ICC                 | el "número" lleva letras                            |
| `ITE326`  | Introducción Sistemas Digitales | aparece listado bajo ICC, pero es de ITE            |
| `1ITE326` | Lab. ITE-326                    | el dígito de delante es **otra materia**, no una variante |

De ahí que el subject se derive del código y nunca del grupo donde apareció, y
que el dígito de prefijo se conserve: quitarlo fusionaba el lab con su teoría.

La otra regla que sostiene esto: **un barrido de catálogo nunca puede pisar un
título real con un placeholder** (`scripts/test-catalog-db.mjs`). Si el título
todavía no llegó, el código hace de título y la materia igual es buscable.

Para llenar el catálogo:

```bash
node scripts/sync-catalog.mjs --subjects    # la lista de subjects (~3 min)
node scripts/sync-catalog.mjs ICC MAT       # títulos + secciones de un subject
```

## Riesgos a tener en cuenta

- **Credenciales**: quedan solo en tu `.env` local (gitignored). Nunca las compartas ni las subas a un repo — así fue como le robaron los cupos a un estudiante de Stevens Institute en 2019 al compartir su script con las credenciales adentro.
- **Política institucional**: varias universidades consideran estos bots una forma de saltarse el proceso de inscripción frente a otros estudiantes y han introducido límites de intentos de login o monitoreo tras detectarlos. Vale la pena revisar el reglamento de PUCMM antes de dejarlo corriendo en producción.
- **No sumar carga en el pico**: el intervalo de polling del watcher no debe bajar de los ~30-45s durante la ventana de alta demanda.
- **Selección de sección relacionada**: si una materia tiene varias secciones de práctico disponibles, `addClassToCart` elige la primera que encuentra — no hay todavía forma de elegir manualmente cuál.
