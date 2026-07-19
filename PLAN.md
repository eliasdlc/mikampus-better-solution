# PLAN v2 — mikampus: la plataforma que micampus debió ser

> Objetivo: dejar de entrar a micampus.pucmm.edu.do. Todo el día a día del estudiante — buscar materias, planificar ciclos, armar horario, inscribirse, ver notas, avance y holds — desde una interfaz local **rápida, organizada y con identidad propia**. PeopleSoft queda como backend invisible al que le hacemos scraping.

---

## 0. Estado real del plan

> Se actualiza al cerrar cada fase. Última actualización: 19-jul-2026 (cierre de LANZAMIENTO L7).

**Completadas:** Fases 1–10, integradas en `dev`, igual que las fases L0–L7 de LANZAMIENTO.md. El único módulo funcionalmente pendiente es Documentos (§12.6), que espera el pénsum oficial 2020 para extraer prerequisitos sin inventarlos.

**Deuda reconciliada por Fase 8.5:** Drop ya existe con doble confirmación; Change Term quedó reconocido; `TARGET_TERM` murió y los defaults salen del modelo de tiempo; notas nuevas notifican y la DB local tiene backup nocturno. Los recons también corrigieron dos supuestos: PUCMM no habilita Validate ni un control/posición de waitlist en su wizard, y Enrollment Dates publica fecha pero no hora — la UI lo dice y nunca inventa medianoche.

**Reglas vigentes desde ya:** toda tabla nueva nace con `user_id` (constante `1` por ahora) — es gratis hoy y le quita filas a la migración multi-usuario; y las fases de LANZAMIENTO.md se citan aquí como **L0–L7** para que "Fase 4" nunca signifique dos cosas.

---

## 1. Principios

1. **PeopleSoft es solo la fuente de datos.** No hay API: todo entra por Playwright (patrón probado en `src/peoplesoft/cart.js` y `classSearch.js`), siempre a través de `withPage()` de `src/session.js`. Cada módulo nuevo = un scraper nuevo, y ningún scraper se escribe a ciegas: primero recon (volcar HTML real + screenshot).
2. **La velocidad se logra no yendo a micampus.** Lo estable (catálogo, notas pasadas, avance, pénsum) se scrapea una vez y se sirve desde disco en <5ms. Solo lo volátil (cupos, carrito) va en vivo, y siempre sin bloquear la UI: se muestra el dato cacheado con su timestamp y se refresca en background (*stale-while-revalidate* en toda la app).
3. **Nombres reales siempre.** La materia se muestra por su nombre ("Estructuras de Datos"); `ICC-303 · 4567` va en chip pequeño monoespaciado al lado. Nunca un código como texto principal.
4. **Cada materia tiene un color estable en toda la app.** Del código se deriva un hue fijo (OKLCH, misma luminosidad y croma para todas): la misma materia se ve del mismo color en búsqueda, planner, builder, horario y carrito. Es el hilo visual que une la plataforma.
5. **Solo lectura + inscripción.** Nada de pagos, ayuda financiera transaccional ni trámites oficiales — ahí un bug cuesta dinero o papeleo. Esos casos linkean a la página exacta de micampus.
6. **Honestidad de estado.** Las operaciones vivas contra PeopleSoft tardan segundos (es Playwright detrás). La UI nunca lo disimula con spinners genéricos: muestra qué paso va ("abriendo carrito… leyendo cupos…") vía el SSE existente, con tiempo transcurrido.

---

## 2. Decisiones técnicas (opciones analizadas)

### Almacenamiento local
| Opción | Veredicto |
|---|---|
| JSON en disco | Simple pero sin queries; los planes + catálogo + snapshots lo vuelven inmanejable |
| **SQLite (better-sqlite3)** ✅ | Sync (sin ceremonia async para un server local), un archivo `data/mikampus.db`, transacciones, y trae FTS si hiciera falta |
| Postgres/Neon | Overkill: app local monousuario, agrega red y credenciales |

### Búsqueda de materias
| Opción | Veredicto |
|---|---|
| SQLite FTS5 | Rápido, pero tokenizador poco amigable con typos y acentos en español |
| Fuse.js | Fuzzy real pero lento en listas grandes (scoring O(n·m)) |
| **MiniSearch en el browser** ✅ | Catálogo de un término son pocos miles de filas → el índice entero vive en memoria del cliente. Prefijos + fuzzy + campo boost, con normalización de acentos propia ("fisica" encuentra "Física"). Resultado: **0 red por keystroke, <10ms por búsqueda** |

El catálogo viaja una vez por sesión (`GET /api/catalog`, JSON comprimido, cacheado por ETag) y el índice se construye en el cliente al arrancar.

### Frontend
| Opción | Veredicto |
|---|---|
| Seguir con HTML/JS plano | Ya no aguanta: planner + builder + estado compartido entre pantallas |
| Next.js | SSR no aporta nada en localhost y complica el pairing con Express/Playwright |
| **Vite + React + TypeScript + Tailwind v4** ✅ | SPA estática servida por el mismo Express; build a `public/dist`; sigue siendo `npm start`. Es tu stack |

Con ella: **TanStack Query** (cache, stale-while-revalidate, reintentos y estados loading/error uniformes), **Zod** (contratos de API compartidos backend/frontend en `src/shared/schemas.ts` — el scraping es frágil, validar su output en el borde detecta selectores rotos al instante), **React Router** (rutas simples, no hace falta más), **cmdk** para la paleta ⌘K, y **SSE** existente para actividad en vivo.

### Vista semanal (WeeklyGrid)
| Opción | Veredicto |
|---|---|
| FullCalendar / librerías de calendario | Pesadas (>100KB), pensadas para eventos arbitrarios, difíciles de teñir con nuestro sistema |
| **CSS Grid propio** ✅ | El dominio es fijo (Lun–Sáb, 7:00–22:00, slots de 15min = `grid-template-rows: repeat(60, 1fr)`). Componente de ~200 líneas, control total de colores, choques y responsive |

### Solver de combinaciones (builder)
Backtracking simple sobre secciones por materia con poda por choque — con 8 materias × 6 secciones es un espacio diminuto, se resuelve local en <10ms. Las combinaciones válidas se **rankean** por heurísticas configurables: menos huecos muertos, días libres completos, no madrugar (nada antes de las 9), compactar en pocos días. Sin librerías.

---

## 3. Sistema de diseño

**Sujeto y trabajo del diseño:** un centro de comando académico para un estudiante de ingeniería que lo usa a diario y *bajo presión* (la inscripción se dispara a una hora exacta, a veces de madrugada). El diseño debe leerse de un vistazo, funcionar de noche, y sentirse como una herramienta propia — no como un portal institucional ni como un template SaaS.

**Firma visual:** el horario como material. Los bloques de materia coloreados por hue estable (principio #4) son la identidad de la app y aparecen hasta fuera del grid: la barrita de color de cada materia en listas, chips y cards es el mismo hue de su bloque. Todo lo demás se mantiene quieto y disciplinado para que el color de las materias sea lo único que canta.

**Paleta** (tokens, modo claro / oscuro):
- `ink` #16181D / `paper` #F7F7F5 — texto y fondo base, neutros cálidos-fríos sin tinte azul genérico
- `surface` #FFFFFF / #1E2128 — cards y paneles
- `line` #E4E4DF / #2C3038 — bordes hairline, nada de sombras difusas
- `accent` #0F62FE→ ajustado a #2557D6 — un azul profundo institucional-pero-no-corporativo, **solo** para acciones primarias y foco; no se usa para decorar
- Estados de cupo: `open` #1F8A4C, `waitlist` #B77900, `closed` #C0362C — muted, legibles en ambos modos
- Materias: 14 hues equidistantes en OKLCH (L=0.72 C=0.11 claro; L=0.68 C=0.13 oscuro), asignados por hash del código de materia

**Modo oscuro por defecto según sistema**, toggle manual persistido. Justificación real: la pre-matrícula se programa de madrugada.

**Tipografía:** tres roles. Display/headings: **Bricolage Grotesque** (carácter sin ruido, números expresivos para el countdown); cuerpo/UI: **Inter** (densidad de datos, x-height alta); datos/códigos: **JetBrains Mono** con `font-variant-numeric: tabular-nums` — todos los `ICC-303 · 4567`, horas y GPAs alinean en columnas. Self-hosted vía Fontsource (la app es local; nada de CDNs en runtime).

**Reglas de composición:** bordes hairline y radios pequeños (6px), sin sombras salvo overlays; densidad tipo herramienta (spacing base 4px, filas de lista de 44px — también es el touch target mínimo); motion mínimo y funcional (transición de 120ms en hovers, un solo momento orquestado: el bloque "aterrizando" en el WeeklyGrid al elegir sección), `prefers-reduced-motion` respetado; foco visible siempre (anillo `accent` de 2px).

**Copy:** en español, voz de herramienta. Botones dicen lo que hacen ("Enviar plan al carrito", no "Confirmar"). Los errores dicen qué pasó y qué hacer ("PeopleSoft no respondió al leer cupos. Reintentar"). Los vacíos invitan a la acción ("Todavía no hay planes. Creá uno para Ago–Dic 2026").

---

## 4. Arquitectura

### Se mantiene
`src/login.js` + `src/session.js` (sesión única en fila con relogin), `src/peoplesoft/enroll.js` (wizard 3 pasos), `src/scheduler.js` (hora fija + watcher), `src/server.js` (crece con endpoints nuevos), SSE de actividad.

### Se refactoriza
`src/peoplesoft/classSearch.js` — hoy elige la primera sección relacionada; pasará a recibir la sección exacta elegida en la UI. `src/peoplesoft/cart.js` — se le suma quitar del carrito y el **Validate** nativo de PeopleSoft (pre-chequea requisitos/choques sin inscribir; hoy está enterrado en el portal y es oro puro antes de la hora cero).

### Backend nuevo
- `src/db.js` — SQLite. Tablas: `courses`, `sections` (+ `seats_snapshot` con timestamp), `plans`, `plan_items`, `grades`, `progress_items`, `holds`, `sync_log`.
- `src/peoplesoft/catalog.js` — recorre el class search de un término (carreras seleccionables) y llena el catálogo. Bajo demanda + cron nocturno opcional. Throttle entre páginas.
- `src/peoplesoft/mySchedule.js` — horario inscrito (materias, sección, aula, profesor, días/horas).
- `src/peoplesoft/grades.js` — notas por término, historial, GPA (Academic Records).
- `src/peoplesoft/progress.js` — avance: requisitos cumplidos/pendientes/en curso, alertas, graduación esperada, asesores (Academic Progress).
- `src/peoplesoft/holds.js` — holds + To-Do list (Centro del Alumnado).
- `src/peoplesoft/dropClass.js` — drop de inscritas (única acción destructiva: doble confirmación en UI).
- `src/shared/schemas.ts` — Zod: todo output de scraper se valida aquí antes de tocar la DB o la UI.

### Frontend nuevo
`web/` (Vite + React + TS + Tailwind) con build servido por Express. Componentes transversales: **`CourseChip`** (nombre + códigos + barrita de color), **`WeeklyGrid`** (el corazón visual), **`CommandK`** (búsqueda global), **`LiveOpBanner`** (progreso paso a paso de operaciones Playwright vía SSE), **`StalenessTag`** ("actualizado hace 2h · refrescar").

---

## 5. Los módulos, uno por uno (qué, cómo se ve, dónde)

### 5.1 Dashboard — `/`
**Qué:** el estado del día en una pantalla. **Layout:** hero con la **próxima clase** (nombre grande en Bricolage, aula y minutos restantes en countdown tabular) sobre una franja del color de esa materia; debajo, la agenda del día como timeline vertical; a la derecha (columna en desktop, abajo en mobile) tres cards de estado: carrito (n materias, próximo disparo programado con countdown), watcher (materias vigiladas y último check), holds activos (rojo solo si hay). Feed de actividad SSE colapsable al pie. **Estados:** si no hay término activo, el hero invita a planificar ("Faltan 34 días para la pre-matrícula de Ago–Dic. Tu plan tiene 5 materias listas"). **Nada de gráficas decorativas** — solo lo accionable hoy.

### 5.2 Buscar materias — `/buscar` (+ ⌘K global)
**Qué:** el reemplazo del class search de 8 clicks. **Cómo:** un solo input grande, resultados instantáneos del índice MiniSearch mientras escribís (nombre, código o profesor; insensible a acentos). Cada resultado es una fila `CourseChip` + créditos + n secciones; expandir muestra la tabla de secciones: profesor, días/horas en mono, aula, cupos con badge de estado (`open/waitlist/closed`) y su `StalenessTag`. **Acciones por sección:** Agregar al carrito · Agregar a un plan · Vigilar cupo. **Filtros como chips togglables** (no formulario): carrera, créditos, día, "sin choque con mi horario actual" — este último cruza contra `mySchedule` local y es imposible en micampus. **Botón "actualizar cupos"** por materia: va en vivo solo para esas secciones, con `LiveOpBanner`. La versión ⌘K es la misma búsqueda en overlay desde cualquier pantalla, con las mismas acciones.

### 5.3 Planner de ciclos — `/planner`
**Qué:** tu punto #3. Planes guardados por término, con dos niveles de compromiso. **Layout:** tabs por término ("Ago–Dic 2026", "Ene–May 2027", "+"); dentro, dos zonas: izquierda la **lista del plan** (CourseChips apilados, con créditos sumados arriba: "5 materias · 19 créditos"), derecha el **WeeklyGrid** del plan. **Materia sin grupos publicados:** queda como "deseada" — chip gris punteado, sin bloque en el grid, con nota opcional ("con Pérez si abre"). **Con grupos:** picker de sección inline (mini-tabla de secciones con profesor y horario) y al elegir, el bloque aterriza en el grid con su color; choques entre bloques se rayan en rojo con tooltip de contra qué chocan. **Integración con avance:** panel colapsable "Pendientes de tu pénsum" sugiere materias elegibles para arrastrar al plan. **Acciones del plan:** duplicar, exportar ICS, y el botón grande **"Enviar plan al carrito"** — manda todas las secciones elegidas al carrito real en batch (con `LiveOpBanner` por materia: agregada ✓ / falló ✗ y por qué), dejando todo listo para que el scheduler dispare a la hora exacta. El plan es la antesala directa de la inscripción automática.

### 5.4 Constructor de horario — `/builder`
**Qué:** tu punto #4, el modo interactivo. **Layout:** split view — izquierda las materias candidatas (del plan o buscadas ahí mismo), cada una expandible a sus secciones como cards chicas seleccionables; derecha el WeeklyGrid vivo. **Interacción:** click en una sección → su bloque aterriza en el grid (el único momento animado de la app); click en otra sección de la misma materia → swap instantáneo para comparar; hover sobre una sección no elegida → preview fantasma semitransparente en el grid. Choques rayados en rojo en tiempo real. **Candado por sección:** fijás las que no negociás. **"Sugerir combinaciones"**: el solver enumera las válidas respetando candados y las presenta como carrusel de mini-grids rankeados por las heurísticas (huecos, madrugones, días libres — pesos ajustables con 3 sliders). Elegir una la carga al grid. **Salida:** "Guardar en plan" o "Enviar al carrito". Mobile: el grid pasa a carrusel de días con snap; la lista de materias va en bottom sheet.

### 5.5 Mi horario — `/horario`
**Qué:** el horario real inscrito. **Cómo:** WeeklyGrid a pantalla completa, bloques con aula y profesor; toggle a vista de lista (agenda por día) que es la default en mobile. **Acciones:** exportar ICS (importable en Google Calendar), vista de impresión limpia, y **drop** por materia — en menú secundario, con doble confirmación que exige tipear el código de la materia. Cache local con `StalenessTag` y refresh bajo demanda.

### 5.6 Notas y avance — `/academico`
**Qué:** Academic Records + Academic Progress unificados. **Tab Notas:** selector de término, tabla de materias (CourseChip, créditos, nota en mono grande), GPA del término y acumulado como dos números grandes con sparkline de evolución histórica al lado (la única gráfica de la app, y se la gana: muestra tendencia real). **Simulador what-if:** editás notas hipotéticas del término en curso y ves el GPA proyectado recalcularse — puro cálculo local. **Tab Avance:** el pénsum como grilla por semestre (columnas), cada materia una card mini con su color y estado: aprobada (llena), en curso (borde animado sutil), pendiente (hueca), elegible-ahora (hueca con borde `accent`). Las elegibles tienen acción directa "agregar al plan". Alertas de requisitos y asesor arriba. Todo cacheado, refresh bajo demanda.

### 5.7 Carrito e inscripción — `/inscripcion`
**Qué:** la pantalla operativa actual, rediseñada como sala de control. **Layout:** izquierda el carrito (filas con CourseChip, sección, estado de cupo vivo, y quitar); derecha el mismo carrito proyectado en WeeklyGrid (ver el horario que estás a punto de inscribir — hoy imposible en micampus). Abajo, la **línea de tiempo de inscripción**: hora programada con countdown grande en Bricolage, botón "Validar carrito ahora" (el Validate nativo de PeopleSoft: detecta holds, requisitos y choques *antes* de la hora cero), watcher de cupos con su intervalo, y botón de inscripción manual. Feed SSE en vivo durante la ejecución con resultado por materia (✓ inscrita / ✗ motivo). 

### 5.8 Holds y pendientes — `/holds`
**Qué:** holds + To-Do list. Lista simple con severidad (bloquea inscripción = rojo, informativo = neutro), descripción completa y, si requiere trámite, link directo a la página exacta de micampus. Los holds bloqueantes se reflejan también como badge en el Dashboard y en `/inscripcion`.

**Fuera de alcance (link out):** pagos/cuenta financiera, ayuda financiera transaccional, solicitudes oficiales, evaluación profesoral (solo un recordatorio en el Dashboard cuando esté abierta).

---

## 6. Performance y responsive: presupuesto y verificación

**Presupuesto (medible, no aspiracional):**
- Carga fría de la SPA (localhost): **<1s** hasta interactivo; bundle inicial **<250KB gz** (React+Router+Query+MiniSearch+cmdk caben; FullCalendar no — por eso el grid propio)
- Keystroke → resultados de búsqueda: **<16ms** (un frame; índice en memoria)
- Navegación entre pantallas: **instantánea** (datos de SQLite ya cacheados por TanStack Query; skeletons solo en primer load)
- Endpoint desde SQLite: **<10ms** server-side
- Operación viva PeopleSoft: la que sea (3–20s), pero **la UI nunca se bloquea** — banner de progreso paso a paso, todo lo demás usable

**Verificación (gate al final de cada fase):**
1. `npm run build` reporta tamaño de bundle; script `scripts/check-budget.mjs` falla si >250KB gz
2. Lighthouse (Chrome headless vía Playwright, que ya está instalado) sobre cada ruta: Performance ≥95, Accessibility ≥95
3. Smoke test Playwright propio: carga cada ruta, screenshot a **390px** (iPhone), **768px** y **1440px** — revisión visual de los tres anchos antes de cerrar la fase
4. Búsqueda medida con `performance.now()` sobre el catálogo real completo
5. Teclado: tab-order completo y ⌘K operable sin mouse; `prefers-reduced-motion` verificado

**Responsive por diseño, no por arreglo:** desktop-first en densidad pero cada módulo define su forma mobile desde el spec (grid → carrusel de días con snap; split views → bottom sheets; tablas de secciones → cards apiladas). Bonus fase 5: manifest PWA + `--host` opcional para abrir mikampus desde el teléfono en la misma red (el server sigue local; las credenciales nunca salen de tu máquina).

---

## 7. Fases

**Fase 1 — Fundación.** SQLite + `catalog.js` (con su recon) + scaffold Vite/React/TS/Tailwind con el sistema de diseño (tokens, CourseChip, layout, dark mode) + migración de las pantallas actuales (carrito, scheduler, watcher) + búsqueda por nombre (5.2 sin filtro de choque). *Gate: presupuesto de performance + los 3 anchos.*

**Fase 2 — Horario.** Recon + `mySchedule.js`, componente WeeklyGrid completo (choques, colores, responsive), pantalla Mi horario con ICS. *El grid desbloquea todo lo visual que sigue.*

**Fase 3 — Planner + Builder.** Planes en SQLite, pantalla 5.3, builder 5.4 con solver y ranking, refactor de `classSearch.js` a sección exacta, "enviar plan al carrito", Validate del carrito, WeeklyGrid en `/inscripcion`.

**Fase 4 — Académico.** Recon + `grades.js`, `progress.js`, `holds.js`; pantalla 5.6 con simulador what-if y pénsum visual; 5.8; integración "elegibles → plan"; filtro "sin choque" en búsqueda.

**Fase 5 — Pulido.** Dashboard completo (5.1), ⌘K global, drop con doble confirmación, cron de sync de catálogo, notificaciones unificadas, PWA + acceso LAN, vista de impresión.

Cada fase: recon → scraper validado con Zod → endpoint → pantalla → gate de verificación → commit atómico por pieza.

## 8. Riesgos

- **Selectores frágiles:** PeopleSoft cambia IDs entre parches → selectores por texto/estructura donde se pueda, recon guardado como referencia, y Zod gritando en el borde cuando un scraper devuelve basura.
- **Volumen del scrape de catálogo:** todas las carreras de un término son muchas requests → throttle, correr fuera de pico, sync selectivo por carrera.
- **Detección de tráfico programático:** ya documentado en README; el cache local reduce los hits al portal muy por debajo del uso manual, salvo el sync de catálogo, que es puntual y espaciado.
- **Datos que el recon puede desmentir:** el pénsum visual (5.6) y "elegibles ahora" dependen de qué exponga realmente Academic Progress; si la página no da estructura de prerequisitos, la feature degrada a estados sin elegibilidad calculada. Se confirma en el recon de Fase 4.

---
---

# PLAN v3 — mikampus entiende tu carrera

> Las fases 1–5 dejaron una plataforma que reemplaza las *pantallas* de micampus. Esta etapa la hace entender al *estudiante*: en qué ciclo está, qué exige su pénsum de verdad (electivas incluidas), dónde está parado en la carrera, qué le toca inscribir, y qué índice puede aspirar a tener. El norte sigue siendo el mismo: organización meticulosa, flujos que se recorren solos, y ningún dato inventado — todo sale del portal o se calcula de forma verificable.

## 9. Auditoría: qué está mal hoy y por qué

Cada punto está anclado al código; ninguno es especulación.

**A. La app no tiene modelo de tiempo.** No existe el concepto "ciclo actual" vs "ciclo que viene". Hoy (julio 2026) el estudiante cursa **Abril de 2026** (4 materias, visibles solo como `in_progress` en la tabla `grades`), pero `enrollments` solo conoce el término **1930 = Septiembre de 2026** (la pre-inscripción de ICC-233). La cadena del bug del Dashboard: `Dashboard.tsx:18` pide `/api/my-schedule` sin término → `server.js:92` cae en `latestScheduledTerm()` (`mySchedule.js:96`) → devuelve 1930 → el hero anuncia como "próxima clase" una materia que empieza en septiembre. Agravante estructural: conviven **dos vocabularios de término que nada une** — códigos STRM (`"1930"`) en `sections`/`enrollments`/`plans` y etiquetas en español (`"Abril de 2026"`) en `grades` y `pensum.taken_term`. No hay tabla que los cruce ni fechas que digan cuál corre hoy.

**B. El pénsum se guarda plano y el portal lo da estructurado.** `parseAdvisement` (`advisement.js:76`) recorre solo las filas `CRSE_NAME$span$` y descarta los encabezados de grupo. Releyendo `fixtures/recon-advisement.html` (mismo fixture, cero recon nuevo): el informe organiza los 27 bloques como **"ICC-2020 Año N Período M"** — cada uno con `Satisfied / Not Satisfied`, `Units: X required, Y taken, Z needed`, `Courses: n required…` y hasta GPA por bloque — y dentro de cada período distingue "Cursos Obligatorios" de **slots de electiva con nombre** ("LIT-E01-T Electiva de Literatura", "ICC-E11-T Electiva I de ICC"…) con su lista de candidatas ("The following courses may be used to satisfy this requirement"). O sea: la conclusión de Fase 4 ("no hay semestre por materia") era falsa — el dato estaba en los encabezados colapsados que el parser no miró. Consecuencias del aplanado actual: (1) las 44 "pending" de la tabla `pensum` mezclan obligatorias reales con candidatas de electivas que jamás vas a cursar; (2) una electiva ya satisfecha no apaga a sus hermanas (tu punto 3); (3) no se puede decir "vas atrasado" porque no hay contra qué; (4) el panel "Pendientes de tu pénsum" del planner recomienda de esa lista inflada.

**C. La app no sabe quién sos.** No hay perfil: carrera, pénsum ("Pénsum No. 2020 de INGENIERÍA EN CIENCIAS DE LA COMPUTACIÓN" — está en el fixture, no se guarda), cohorte (deducible: tu primer término con notas es Septiembre de 2023). Por eso `/buscar` indexa el catálogo entero (907 materias, 711 subjects) en vez de arrancar por tu carrera, y no hay dónde colgar metas.

**D. Lo que ya está bien y se reusa tal cual.** La aritmética del GPA (`shared/gpa.ts`) reproduce el portal y ya alimenta un what-if en `/academico` — el punto 7 es una extensión, no una construcción. El solver, los planes, el carrito cacheado y el patrón recon→fixture→parser→endpoint→pantalla quedan intactos. El cron de catálogo ya barre por subjects del pénsum.

**Restricción confirmada que sigue en pie:** el portal **no publica prerequisitos** en ninguna pantalla reconocida (advisement, class search, browse catalog). "Chequear pre/corequisitos" no se puede scrapear; ver §13 para cómo se degrada con honestidad.

## 10. Modelo de datos nuevo

Todo aditivo (patrón `addColumnIfMissing` / `CREATE TABLE IF NOT EXISTS`); nada rompe lo existente. Desde la Fase 8.5, toda tabla nueva nace con `user_id` (constante `1` por ahora): LANZAMIENTO L2 migra menos.

- **`terms`** — `code` (STRM, PK), `label` ("Abril de 2026"), `start_date`, `end_date`, `updated_at`. Fuentes que ya tenemos sin recon nuevo: el dropdown del class search (`getSearchFormOptions`) lista código+etiqueta de los términos elegibles; Mi Horario da etiqueta (header) + código (`PIA_KEYSTRUCT.STRM`) del que sincroniza; las fechas salen de `enrollments.start_date/end_date` (MTG_DATES). La resolución vive en `src/shared/terms.ts` (pura, testeada): `currentTerm` = el que contiene a hoy; `nextTerm` = el primero que empieza después; fallbacks explícitos cuando faltan fechas. `grades.term` (etiqueta) se cruza contra `terms.label`.
- **`profile`** — una fila: `career`, `pensum_no`, `plan_label`, `cohort_start_term`. Se llena desde el advisement + primer término de `grades`; editable.
- **`requirement_groups`** — el árbol del advisement: `id`, `parent_id`, `label`, `kind` (`periodo` / `obligatorios` / `electiva`), `year`, `period`, `satisfied`, `units_required/taken/needed`, `courses_required/taken/needed`, `gpa_actual`, `position` (orden del documento — la verdad sobre la secuencia aunque la etiqueta cambie en otro pénsum).
- **`requirement_courses`** — `group_id`, `code`, `status`, `grade`, `taken_term`, `units`. La tabla `pensum` actual pasa a **derivarse** de estas dos (se reconstruye en cada sync para no romper `/api/pensum`, el planner ni el cron), y gana la semántica correcta: *pendiente real* = lo que falta de grupos no satisfechos; candidata de electiva satisfecha = ya no te interesa; fuera de todo grupo = fuera de tu pénsum.
- **`goals`** — `id`, `kind` (`gpa` por ahora), `target` (REAL), `deadline_term`, `created_at`, `achieved_at`.
- **`enrollment_windows`** (Fase 8.5) — `term_code`, `starts_at`, `ends_at`, `user_id`, `synced_at`: el enrollment appointment scrapeado del Centro del Alumnado. Es la fuente del countdown de pre-matrícula (§5.1, §12.3) — que hasta ahora se prometía en la UI sin tener ninguna.
- **`prereqs`** (condicional, ver §13) — `code`, `requires_code`, `kind` (`pre`/`co`), `source` (`manual`). Solo existe si se decide sembrarla; nada la asume.

## 11. Arquitectura de navegación: tres zonas de tiempo

La regla que ordena todo mikampus a partir de ahora: **ninguna pantalla mezcla ciclos sin decirlo**. Cada vista term-scoped lleva un `TermBadge` ("Abril–Julio 2026") y las tres zonas del sidebar responden preguntas distintas:

| Zona | Pregunta | Rutas |
|---|---|---|
| **Ahora** | ¿qué tengo hoy? | `/` (Hoy), `/horario` (con switcher de ciclo) |
| **Próximo ciclo** | ¿qué inscribo? | `/planner`, `/builder`, `/buscar`, `/inscripcion` |
| **Mi carrera** | ¿dónde estoy parado? | `/trayectoria` (nueva), `/academico`, `/holds` |

El Dashboard se reparte igual: el hero y la agenda son **solo del ciclo actual**; lo del ciclo que viene vive en una card propia "Próximo ciclo" (materias ya inscritas + estado del plan/carrito + countdown de inscripción), que es donde ICC-233 tiene que aparecer — como futuro, no como próxima clase. Buscar y planner operan por defecto sobre `nextTerm` (para eso planificás); el filtro de choque cruza contra el horario del término correspondiente.

**Carrera-first (tu punto 2):** el índice de búsqueda (/buscar y ⌘K) arranca acotado a tu pénsum (`requirement_courses` ∪ inscritas); un chip "Todo el catálogo" — apagado por defecto, estado visible — abre el resto. Igual en cada lista de la app: lo que no es de tu pénsum no compite por tu atención salvo que lo pidas.

## 12. Los módulos nuevos

### 12.1 Fase 6 — El tiempo (arregla el punto 1)
Tabla `terms` + `shared/terms.ts` + endpoint `/api/terms` enriquecido (código, etiqueta, fechas, cuál es actual/siguiente). Dashboard: hero/agenda del ciclo actual, card "Próximo ciclo". `/horario` gana switcher de término. **Único recon en vivo de la fase:** el "change term" de Mi Horario (cuando hay más de un término activo, PeopleSoft ofrece elegirlo) para poder sincronizar el horario del ciclo en curso — hoy `syncSchedule` toma el que el portal dé por defecto (así entró 1930 y no Abril). Hasta ese recon, el Dashboard ya deja de mentir con lo que hay: sabe que 1930 no corre hoy. *Gate: tests de resolución de término (con fechas, sin fechas, entre ciclos) + el smoke verifica que el hero no muestra materias de un término futuro.* **Nota al cierre:** la fase entró a `dev` sin el recon del change term — lo hereda la Fase 8.5 (§12.4.f).

### 12.2 Fase 7 — El pénsum de verdad (arregla 2, 3 y 4)
Parser v2 del advisement **contra el fixture existente**: recorre los `win0divDERIVED_SAA_DPR_SAA_DESCRLONG_*` construyendo el árbol período → obligatorios/electivas → cursos, con los contadores Satisfied/needed de cada grupo. Llena `requirement_groups`/`requirement_courses` + `profile`; `pensum` se deriva. `/api/pensum` v2 devuelve el árbol. `/academico` → Avance se rediseña: columnas (desktop) o acordeón (mobile) por **Año/Período** — lo que el plan §5.6 quería y creíamos imposible — con las electivas como *slots* ("Electiva de Literatura: ✓ satisfecha con LET-201" / "elegí 1 de 8") en vez de listas infladas. Búsqueda carrera-first con el chip "Todo el catálogo". El panel del planner pasa a sugerir *pendientes reales*. *Gate: el parser reproduce exacto los 3 grupos Satisfied / 24 Not Satisfied y los 81 créditos faltantes del fixture; una electiva satisfecha oculta a sus candidatas; test de que ninguna materia fuera de grupo entra al pénsum derivado.*

### 12.3 Fase 8 — Trayectoria (el punto 5)
Ruta nueva `/trayectoria`: la carrera como línea de tiempo vertical, un nodo por término ordenado por `termSortKey` — pasado (materias + nota + GPA del término, de `grades`), **presente** (en curso), **próximo ciclo** (inscrito + plan + carrito), **futuro** (los períodos no satisfechos del pénsum, en orden, con sus créditos faltantes). Arriba, la posición: "Año 2 Período 3 de 11 · 131/212 créditos · ~N ciclos para terminar" y el **atraso medido contra el pénsum**: períodos ya transcurridos desde tu cohorte (3 ciclos/año, de `terms`) vs. bloques satisfechos — "llevás 1 materia de Año 1 Período 3 pendiente" es un hecho verificable, no una vibra. *Gate: las cifras del encabezado cuadran con los totales del advisement; smoke en los 3 anchos (la línea de tiempo es propensa a desbordar en 390px).*

### 12.4 Fase 8.5 — Reconciliación (cerrada 18-jul-2026)

La auditoría de jul-2026 encontró promesas de v2 que nunca se construyeron, el dato más crítico del dominio sin fuente, y cabos sueltos del modelo de tiempo. Todo se cierra aquí — una fase con dueño, antes de que la Fase 9 construya encima. Cada pieza sigue la disciplina de siempre (recon → fixture → parser+test → endpoint → pantalla) y es su propio commit atómico.

**a) Validate del carrito** (deuda de Fase 3, §4): recon del Validate nativo → `cart.js` gana `validateCart()` → botón "Validar carrito ahora" en `/inscripcion` con resultado por materia vía `LiveOpBanner`. Es el pre-chequeo de holds/requisitos/choques *antes* de la hora cero — la razón por la que el plan lo llamó "oro puro" sigue intacta.

**b) Drop** (deuda de Fase 5, §5.5): recon del flujo → `dropClass.js` → acción en `/horario` con doble confirmación tipeando el código. Sigue siendo la única acción destructiva de la app.

**c) La hora de inscripción como dato** (el hueco más caro que encontró la auditoría): recon del **enrollment appointment** ("Enrollment Dates" del Centro del Alumnado) → tabla `enrollment_windows` (§10) → el countdown del Dashboard y de `/inscripcion` deja de ser un número sin fuente, y el scheduler **propone la hora exacta en un click** en vez de pedir que la tipees a mano. Alimenta directo el pre-warming de LANZAMIENTO §5.6.

**d) Waitlist como decisión, no como color**: `waitlist` existe solo como badge (§3). Recon de qué hace el wizard de enroll cuando la sección está llena (¿checkbox "wait list if class is full"?) y de si el portal expone tu posición en lista. Con el recon en mano, la política (toggle por materia en el carrito: "si está llena, ¿waitlist sí/no?") se decide en §13 — hoy `enroll.js` hace lo que el portal haga por defecto y nadie sabe qué es.

**e) El modelo de tiempo llega a todos los endpoints**: `server.js:213` y `server.js:274` todavía caen en `TARGET_TERM` del `.env` antes que en `resolveTerms`. La regla de §11 (buscar/planner operan por defecto sobre `nextTerm`) se cablea de verdad, y `TARGET_TERM` queda como override explícito documentado — o muere. *Test: sin `TARGET_TERM` en el `.env`, ningún default cambia.*

**f) Change Term** (deuda de Fase 6): el recon pendiente por fin tiene dueño. Si revela que un término en curso deja de ser consultable a mitad de ciclo, aplica la degradación honesta ya escrita en §14.

**g) Push de notas nuevas**: el sync de grades reemplaza el histórico entero (`grades.js:283`); antes del replace se diffea contra lo conocido y una nota nueva notifica ("Se publicó tu nota de ICC-303: A"). El canal (`notify.js`) ya existe. En semana de finales es la feature más usada de la app, a costo casi cero.

**h) Backup local**: el cron nocturno guarda una copia fechada de `data/mikampus.db` (rotación ~7 días). LANZAMIENTO trae Litestream para el hosted; el modo local no puede seguir a un `rm` de distancia de perder años de notas.

**i) Cadencia del atraso**: verificar contra el fixture del advisement cuántos períodos por año asume el pénsum ICC-2020. Si no es 1:1 con los 3 ciclos del calendario, `behindCycles` (`shared/trajectory.ts:144`) se ajusta al ritmo del documento, no al del calendario — el "vas atrasado" no puede acusar a alguien que va perfecto.

*Gate reconciliado: Validate/waitlist reconocidos contra el portal real; Drop reconocido hasta su confirmación destructiva y cubierto por fixtures; Dashboard e Inscripción muestran la precisión real de Enrollment Dates; test de `TARGET_TERM`, diff de notas, backup y cadencia; smoke en los 3 anchos.*

**Nota al cierre (lo que desmintió el recon):** el wizard real no muestra Validate ni en el carrito ni en el paso 2, y tampoco ofrece toggle ni posición de waitlist; mikampus expone esa ausencia en vez de simular un chequeo. Enrollment Dates dio `16-jul–3-sep 2026` con precisión de **fecha**, no hora: Dashboard e Inscripción muestran la fecha y “hora no publicada”, mientras el scheduler conserva la entrada manual. El flujo Drop se verificó en vivo hasta “Finish Dropping” y su parser usa fixtures de ambos pasos; el click final destructivo no se ejecutó durante el recon porque habría dado de baja la matrícula real. El fixture ICC-2020 confirmó **3 períodos/año**, 1:1 con los tres ciclos del calendario. Suite, presupuesto y smokes 390/768/1440 pasaron.

### 12.5 Fase 9 — El recomendador (el punto 6)
`src/shared/recommend.ts` — motor puro y testeado, cero red: entradas = árbol de requisitos, historial, catálogo del término objetivo, carga máxima deseada; salida = materias recomendadas **con su porqué** ("pendiente de Año 1 Período 3 — es lo más viejo que te falta", "slot Electiva de Filosofía: 3 candidatas se ofertan"). Estrategia: primero lo pendiente del período más antiguo no satisfecho (así el atraso se drena solo), después el período que sigue; electivas ofrecen candidatas, no imponen; solo materias con secciones en el término objetivo. Dos garantías que agregó la auditoría: **toda salida pasa por el solver** (`shared/solver.ts`, ya existe y corre en <10ms) — si el conjunto recomendado no tiene ninguna combinación de secciones sin choques, el motor lo dice y ofrece el subconjunto armable, nunca entrega un plan inarmable; y **una candidata cuenta para un solo slot de electiva** — nada de satisfacer dos requisitos con la misma materia. En el planner: botón **"Generar plan recomendado"** que crea un plan normal — editable, borrable, reorganizable con total libertad, como cualquier otro (tu "y también debe permitirte reorganizar": ya lo cumple la infraestructura de planes; el recomendador solo pre-llena). El Dashboard, cuando exista `nextTerm` sin plan, lo ofrece proactivamente. *Gate: tests del motor con los tres perfiles (al día / atrasado / solo electivas) + el caso real del fixture + ninguna recomendación sale sin combinación válida del solver + test de doble conteo de electivas.*

**Cerrada 18-jul-2026.** El motor prioriza por `position` del árbol, descuenta historial y carga máxima, asigna cada candidata de electiva una sola vez y agrega materias de forma incremental solo si el solver conserva una combinación. La propuesta muestra el porqué y las alternativas de electiva; `POST /api/recommendation/plan` recalcula y guarda la combinación completa en una transacción como plan común con secciones elegidas y notas editables. Dashboard ofrece el flujo cuando `nextTerm` no tiene plan. Gate pasado: perfiles al día/atrasado/solo electivas, choque con reducción honesta, doble conteo, fixture real, persistencia transaccional, bundle 168.9 KB gzip y smoke 390/768/1440 sin overflow.

### 12.6 Módulo de documentos — lo que el portal no da, lo trae un papel
**Qué:** hay datos que micampus no expone en ninguna pantalla (los prerequisitos son el caso probado) pero que la universidad sí publica en documentos oficiales. Este módulo los incorpora: el estudiante aporta el documento, un parser extrae los datos y los guarda **con procedencia** — cada dato sabe de qué documento salió y la UI lo dice ("según pénsum 2020", nunca como palabra del portal).

**Cómo — la misma disciplina de siempre, con el documento como fixture:** un documento aportado se trata exactamente igual que un volcado de recon: entra a `fixtures/` (pasando por el scrubber de PII si trae nombre/matrícula), se escribe el parser contra él con su test, y solo entonces los datos tocan la DB. Nada de parseo "al vuelo" sin fixture: si el parser se equivoca callado, el recomendador valida prerequisitos falsos — peor que no validar. Cada tipo de documento es su propio mini-recon: parser, esquema Zod y test propios.

**Primer documento: el pénsum oficial 2020** (Registro; trae pre y correquisitos por materia). **PENDIENTE de que llegue el documento — no se analiza ni se diseña el parser a ciegas**: el formato real (PDF con tablas, escaneado, columnas) decide la técnica de extracción, igual que el HTML real decidió cada scraper. Cuando esté: análisis del formato → parser + fixture + test → llena `prereqs` (`code`, `requires_code`, `kind` pre/co, `source`) → cruza contra el catálogo por código canónico (`shared/courseCode.ts`, la regla compartida de siempre) y contra `requirement_courses` — un prereq que menciona una materia que el pénsum no conoce es un error del parser hasta demostrar lo contrario. Los **correquisitos** (`kind: co`) tienen consumidor definido desde el diseño: el solver, el builder y el envío al carrito exigen que entren juntos al mismo término — la validación no vive solo en el recomendador, vive donde se arma el horario.

**Dónde vive:** los datos derivados alimentan lo existente (el recomendador de Fase 9, `/academico`); no hay pantalla nueva salvo, más adelante, un lugar en el perfil que liste los documentos incorporados y qué aportó cada uno. Candidatos futuros del mismo patrón: el "Reporte Orientación Académica" en PDF, el calendario académico (fechas exactas de ciclos e inscripción para la tabla `terms`).

### 12.7 Fase 10 — Metas y señales (los puntos 7 y 8)
**Metas:** CRUD de `goals` + proyecciones en `shared/gpa.ts` (misma aritmética verificada, sin segunda implementación). Con los créditos faltantes del pénsum (81, del advisement) se calcula el abanico honesto: índice final si todo lo que queda es A (mejor caso) / si mantenés tu promedio histórico (caso medio) / si es C (piso razonable); y para una meta dada, el promedio que exige en lo restante — incluida la respuesta "inalcanzable: ni con todo A llegás a X antes de Y", que es la más valiosa. **Las proyecciones modelan la repetición** (hallazgo de la auditoría): repetir una materia con C o F suele mover el índice más que cualquier A nueva, así que primero se verifica contra el histórico real qué hace PUCMM al repetir (¿la nota nueva reemplaza o promedian ambas? — `grades.js` ya distingue repetidas y `shared/gpa.ts` reproduce el portal: es un test, no una opinión) y el motor de metas la incluye como palanca: la respuesta a una meta puede ser "repitiendo ICC-2xx llegás; solo con materias nuevas, no". Hasta que esa política esté verificada, el veredicto "inalcanzable" no se emite. Vive en `/academico` junto al what-if, que ya proyecta el término en curso. **Señales:** `shared/insights.ts`, descriptivas y con test cada una — tendencia del índice (últimos 3 términos), rendimiento por área (subjects con ≥2 materias), carga vs. resultado (créditos/término contra GPA de ese término), materias repetidas o retiradas. Se muestran como hechos con número al lado, no como sermones; sin datos suficientes, la señal no aparece (nada de consejos genéricos). *Gate: proyecciones contrastadas a mano contra el fixture real; ninguna señal se emite bajo su umbral de datos; la política de repetición verificada contra el histórico antes de habilitar veredictos de meta.*

**Cerrada 18-jul-2026 e integrada con las Fases 8–9.** `projectFinalGpa`/`feasibilityForGoal` en `shared/gpa.ts` dan el abanico (3.2 / 2.8 / 2.5 sobre 81 faltantes) y el veredicto reachable/tight/unreachable/secured/met; `shared/insights.ts` las cinco señales con su umbral; tabla `goals` + `src/goals.js` (CRUD + evaluación en vivo) + endpoints `/api/goals` (GET/POST/PATCH/DELETE) e `/api/insights`; panel Metas + Señales en `/academico`. **Política de repetición verificada, no supuesta:** el histórico real (IIS-223 F→D, ambos contados en los totales del portal) confirma que PUCMM *promedia* los intentos, no reemplaza — por eso el veredicto "inalcanzable" ya se emite, y por eso repetir no es una palanca especial (cada crédito futuro entra al promedio igual que uno nuevo). Gate pasado: proyecciones a mano contra el fixture, cada señal bajo su umbral, suite verde, bundle 165 KB gz y smoke 390/768/1440 sin overflow.

## 13. Decisiones abiertas (del lado del producto)

1. **Prerequisitos — RESUELTA: entran por el módulo de documentos (§12.6).** El estudiante aporta el pénsum oficial 2020 y un parser (con fixture y test, como todo) llena `prereqs`; el recomendador valida de verdad, marcado en UI como "según pénsum 2020". Hasta que el documento llegue y su parser exista, la Fase 9 recomienda por orden de pénsum + "se oferta" — el motor nace con el enchufe para prereqs pero sin depender de él.
2. **Copy de las señales (Fase 10)** es texto de cara al usuario → se propone antes de commitear esa pantalla.
3. **Waitlist (tras el recon de §12.4.d):** cuando una sección del carrito está llena a la hora del disparo — ¿entrar a la lista de espera o no? La forma probable es un toggle por materia en el carrito; el default y el copy son tuyos. No se implementa nada hasta que el recon diga qué ofrece el portal realmente.
4. **Secuencia con LANZAMIENTO:** ¿Fases 9–10 antes del multi-usuario (L2) o después? La regla de `user_id` (§0) abarata cualquiera de los dos órdenes, pero el orden en sí es tuyo. Y LANZAMIENTO tiene que reconciliarse con lo ya construido: su sidebar final (L§12, 6 entradas) omite `/trayectoria` — dónde vive Trayectoria en la navegación nueva es decisión de producto.

## 14. Riesgos nuevos

- **El recon del "change term"** puede revelar que un término en curso ya no es consultable en Mi Horario a mitad de ciclo; si pasa, el horario actual se reconstruye desde `grades` (materias sin aulas/horas) y se dice honestamente que el portal ya no lo da.
- **Las etiquetas "Año N Período M" son del pénsum ICC 2020**; otro pénsum puede nombrar distinto. Por eso `position` (orden del documento) es la verdad para secuenciar y la etiqueta es solo display.
- **El atraso es una inferencia** (cohorte + 3 ciclos/año): se muestra con su base de cálculo visible y la cohorte es editable en el perfil.

Regla de siempre: recon → parser con fixture + test → endpoint → pantalla → gate → commit atómico. La Fase 8.5 concentra todos los recons que quedaban (Validate, drop, appointment, waitlist, change term); Fase 9 y Fase 10 son cálculo local puro; el módulo de documentos espera su documento.
