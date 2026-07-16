# PLAN v2 — mikampus: la plataforma que micampus debió ser

> Objetivo: dejar de entrar a micampus.pucmm.edu.do. Todo el día a día del estudiante — buscar materias, planificar ciclos, armar horario, inscribirse, ver notas, avance y holds — desde una interfaz local **rápida, organizada y con identidad propia**. PeopleSoft queda como backend invisible al que le hacemos scraping.

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
