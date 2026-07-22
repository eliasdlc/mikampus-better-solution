# mikampus

> Estado: migración en curso a una herramienta open source, local y single-user.
> Fase 1 completada: mikampus no ofrece ni soporta despliegues hosted o
> multiusuario.

mikampus busca convertirse en una herramienta que cada estudiante ejecuta en
su propio hardware con su propia cuenta. No está afiliada, autorizada ni
respaldada por PUCMM. Usarla puede violar términos institucionales y tener
consecuencias académicas; la licencia MIT no garantiza legalidad ni seguridad.
No uses ni compartas credenciales de otra persona.

El plan vigente está en [`PLAN-LOCAL-OPENSOURCE.md`](./PLAN-LOCAL-OPENSOURCE.md).
La política de privacidad, egress, amenazas y fixtures está en
[`docs/local-security.md`](./docs/local-security.md).

Hoy funciona:

1. **Buscar materias** — un input, resultados instantáneos del catálogo cacheado (índice MiniSearch en el cliente, insensible a acentos).
2. **Carrito e inscripción** — carrito en vivo, hora fija de pre-matrícula, watcher de cupos e inscripción manual.
3. **Actividad en vivo** — cada operación Playwright reporta su progreso por SSE.

Todo corre sobre una única sesión de Playwright (headless) del operador. Si la
sesión expira puede re-login solo mientras exista una autorización de
credencial vigente; ante password rechazado, MFA o CAPTCHA se detiene y pide
intervención, sin martillar el portal. Los datos estables (catálogo) viven en
SQLite y se sirven desde disco; solo lo volátil (cupos, carrito) va en vivo.

## Desarrollo (no es instalación de usuario final)

```bash
npm install
npm run install-browsers   # descarga Chromium para Playwright
cp .env.example .env
npm run build              # compila la SPA (web/ → public/dist)
npm start                  # backend local de desarrollo en http://localhost:4173
```

Abrí `http://localhost:4173`. Para desarrollar el frontend con hot-reload:
`npm run dev` (Vite en :5173 con proxy de `/api` al backend en :4173, que debe
estar corriendo con `npm start`). El servidor se fija a loopback y rechaza
orígenes y hosts ajenos: no expongas este proceso a una LAN o Internet.

Para que la búsqueda tenga contra qué buscar, llená el catálogo desde el portal: `node scripts/sync-catalog.mjs ICC` (ver [De dónde sale el nombre de cada materia](#de-dónde-sale-el-nombre-de-cada-materia)). Tarda unos minutos por subject y solo hace falta una vez por término. `scripts/seed-catalog.mjs` siembra 4 materias **inventadas** y es solo para probar la UI sin portal — no lo corras contra la base real.

## Stack

- **Backend** — Node + Express, Playwright para el scraping, `node:sqlite` (built-in, sin compilación nativa) para el catálogo y los planes en `data/mikampus.db`.
- **Frontend** — Vite + React + TypeScript + Tailwind v4, TanStack Query (stale-while-revalidate), React Router, MiniSearch. SPA en `web/`, build servido por el mismo Express.
- **Contratos** — Zod en `src/shared/schemas.ts`, importado tal cual por backend (TS nativo de Node) y frontend: todo output de scraper se valida en el borde.

## Verificación (gate de cada fase)

```bash
npm test                                         # parsers + DB + grid + ICS, sin tocar el portal
npm run typecheck                                 # contratos TypeScript de frontend/shared
npm run lint                                      # errores estáticos de JavaScript
npm run audit:public                              # secretos/PII conocidos en HEAD
npm run build && node scripts/check-budget.mjs   # bundle inicial < 250KB gz
node scripts/bench-search.mjs                    # keystroke → resultados < 16ms
npm run smoke                                    # screenshots a 390/768/1440px + falla si hay desborde horizontal
```

`npm test` corre los parsers contra fixtures sanitizados y revisados (sin tokens
ni datos personales — ver `scripts/make-fixture.mjs` y
`fixtures/manifest.json`). Es la red de los selectores: PeopleSoft cambia IDs
entre parches y esto falla antes que un barrido en vivo. Los fixtures nuevos
deben ser fragmentos sintéticos mínimos; no subas una página completa. Para
preparar un fragmento desde recon local:

```bash
npm run recon:catalog                            # RECON_PREFIX=ICC3 acota la búsqueda
npm run recon:schedule
node scripts/make-fixture.mjs screenshots/recon-schedule-list.html  # revisar y reducir antes de commitear
```

## Cómo funciona por dentro

- `src/login.js` — login contra el signon real de PUCMM.
- `src/session.js` — la única sesión del operador, en fila (nunca dos acciones de Playwright en paralelo), con re-login solo si la credencial autorizada sigue vigente.
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

- **Credenciales**: se ingresan en la UI. La sesión interactiva queda en RAM; las funciones desatendidas requieren consentimiento y usan el almacén seguro del OS o el vault cifrado de Home Server. Nunca las compartas ni las subas a un repo.
- **Política institucional**: varias universidades consideran estos bots una forma de saltarse el proceso de inscripción frente a otros estudiantes y han introducido límites de intentos de login o monitoreo tras detectarlos. Vale la pena revisar el reglamento de PUCMM antes de dejarlo corriendo en producción.
- **No sumar carga en el pico**: el intervalo de polling del watcher no debe bajar de los ~30-45s durante la ventana de alta demanda.
- **Selección de sección relacionada**: si una materia tiene varias secciones de práctico disponibles, `addClassToCart` elige la primera que encuentra — no hay todavía forma de elegir manualmente cuál.
