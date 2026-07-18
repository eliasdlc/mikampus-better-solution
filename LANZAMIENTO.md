# LANZAMIENTO.md — de herramienta personal a plataforma para compañeros

> Audit de decisiones para llevar mikampus a producción en `mikampus.decruce.dev`, con login por estudiante y datos aislados por usuario. Cada decisión está anclada al código actual. v2: incorpora las notas de Elias (privacidad de credenciales, costo cero, lazy loading, watcher con notificación inmediata, grupos nuevos, búsqueda con recomendación, refresh global) y las decisiones tomadas sobre ellas.

**Principios que ordenan todo el documento** (salen de las notas, no son decoración):

1. **Costo cero.** El hosting es gratis o no es. Nada de planes pagos "baratos".
2. **Open source, y corre local.** El repo es público y cualquiera puede correr mikampus completo en su máquina (modo single-user, el comportamiento actual). El deploy hosted es *una* instancia de eso, no un fork.
3. **Las credenciales no viven en la DB principal, jamás.** Solo se persisten —cifradas, en un almacén aparte— cuando una feature desatendida lo exige, y se borran cuando deja de exigirlo.
4. **La app es inteligente con los datos:** muestra lo cacheado al instante, refresca solo lo vencido, nunca borra por expirar, nunca obliga a sincronizar para poder mirar.

---

## 0. Diagnóstico: qué asume "un solo usuario" hoy

Todo el backend está construido sobre la premisa de una sola persona. Estos son los puntos exactos que hay que romper para el multi-usuario:

- **Una sola sesión de Playwright global.** `src/session.js:1-27` mantiene `browser`/`page` como variables de módulo y `withPage()` encola todas las acciones en una única fila. Con dos usuarios, el segundo scrapearía con la sesión del primero. !NOTA: me gustaria saber si es posible tener varias sesiones de playwright para varios usuarios distintos, porque si por ejemplo hay 10 estudiantes en mikampus y los 10 estan jalando info de micampus habria un problema con que solo exista una sola sesion.
- **Una sola cuenta del portal.** `src/credentials.js` lee `data/account.json` o el `.env` — la contraseña vive en texto plano en disco. Válido para modo local; inaceptable en el server hosted (ver §5, dónde vive cada credencial).
- **Datos personales sin dueño.** En `src/db.js`, las tablas `grades`, `holds`, `enrollments`, `cart_rows`, `plans`, `progress_items` no tienen columna de usuario. Cada una necesita `user_id`. `pensum` es un caso especial: es compartido por carrera, no personal (ver §3.1).
- **Scheduler y watcher globales.** `src/scheduler.js` y `src/cron.js` asumen un único disparo programado y un único watcher. Cada estudiante necesita los suyos, persistidos en DB (si el server se reinicia a las 5:59am, el disparo de las 6:00 tiene que sobrevivir — hoy viven en memoria, `scheduler.js:29-32`). !NOTA: me tienes que preguntar que se va a ejecutar en los schedulers y watchers y a que hora porque no quiero hacer esto a ciegas, hay que ser organizados.
- **Cero auth en el server.** `src/server.js` sirve `/api/*` sin autenticación. Bloqueante absoluto para deploy.

## 0.5. Fase 0 — verificar antes de construir

Tres supuestos pueden invalidar la arquitectura entera y se comprueban en una tarde cada uno, **antes** de escribir una línea de multi-usuario:

1. **¿Micampus acepta tráfico desde la IP de Oracle Cloud?** El free tier vive en datacenters extranjeros; portales universitarios a veces bloquean o degradan tráfico no-residencial. Prueba: levantar la VM gratis y correr `loginToPeopleSoft` desde ahí. Si falla, el plan B es descartar totalmente la idea de hacer un servidor porque no puedo usar mi computadora para eso y solamente apuntar al opensource y que cada uno corra su mikampus.
2. **¿El portal tiene o anuncia MFA?** Toda la arquitectura de re-login desatendido asume que usuario+contraseña bastan. Verificar la situación real hoy y diseñar el mensaje de fallo para el día que cambie.
   - !NOTA: No tiene MFA, lo unico que necesitas es las credenciales y ya estas adentro.
3. **¿La hora de inscripción es la misma para todos?** En PeopleSoft los enrollment appointments suelen ser *por estudiante*. Si es así: (a) el pico de las 6:00am es menor de lo temido, y (b) mikampus debería **leer el appointment de cada estudiante del portal y proponerle programar su hora** — feature de valor real que hoy no existe (el usuario escribe la hora a mano).
   - !NOTA: La inscripcion es por escuelas, cada carrera tiene una hora diferente, entonces por ejemplo todos los estudiantes de ingenieria se inscriben a la misma hora.

---

## 1. Arquitectura multi-usuario

**Decisión: server único de larga vida con pool de sesiones Playwright por usuario + una sesión de servicio para lo compartido.**

- `withPage(fn)` pasa a `withPage(userId, fn)`: un mapa `userId → { context, page, queue }` usando **browser contexts** de un solo Chromium compartido (un context por usuario aísla cookies/sesión del portal). Contexts inactivos se cierran tras N minutos; el patrón de re-login ya existe en `ensureSession()`. !NOTA: usar un solo chromium para todos los estudiante es una locura, osea no va a dar para nada y todos los procesos van a ser lentos.
- Cola por usuario (la fila actual de `session.js:33-48`, una por context) + límite global de contexts concurrentes. !NOTA: es lo mismo que te decia antes, se van a generar colas larguisimas que van a dejarle un mal gusto al usuario.
- **Sesión de servicio [DECIDIDO]:** la cuenta de Elias actúa como cuenta de servicio para el sync compartido (catálogo, secciones, cupos, pénsums por carrera). Los estudiantes se benefician sin exponer sus sesiones; la visibilidad del scraping de fondo la absorbe una sola cuenta. Su context es uno más del pool, con su propia cola.
- El watcher y la hora programada se vuelven **filas por usuario en DB** (persistidas, no en memoria).
- Un crash del Chromium compartido tumba a todos los contexts a la vez: el pool necesita detección de crash + relanzamiento, y el día-D se prueba con N logins simultáneos antes, no ese día (§13).

**Costo real:** cada context activo son ~80–150MB. Con 10–20 compañeros y picos solo en pre-matrícula, la VM del free tier (24GB) sobra.

## 2. Deploy

**Decisión [DECIDIDO]: Oracle Cloud Always Free (VM ARM A1, hasta 4 OCPU / 24GB RAM) + Docker + Caddy. El proyecto es open source y corre completo en local.**

- **$0 permanente**, no trial. Corre Playwright + server 24/7 y los estudiantes entran por `mikampus.decruce.dev`.
- Docker con la imagen oficial de Playwright (ARM64 existe), `docker compose` con server + volumen de datos, **Caddy** como reverse proxy con TLS automático.
- Riesgos propios de Oracle: (a) reclama VMs ociosas en cuentas free — se mitiga con la actividad regular del propio server y monitoreo; (b) la IP de datacenter — se valida en Fase 0. **Plan B:** tu máquina + Cloudflare Tunnel (gratis, IP residencial).
- **Modo local:** el repo mantiene el modo actual single-user (`npm run dev` / futuro `npx mikampus`): credenciales en `.env`/`account.json` local, sin auth, sin multi-usuario. Es el mismo código con `MODE=local` — no un fork. Esto es lo que hace honesto el "open source": cualquiera puede auditarlo y correrlo sin confiar en el server de nadie.

Descartados: Vercel/serverless (Playwright + SSE + scheduler no caben en funciones), Railway/Fly (RAM para Chromium se paga), VPS pago (viola el principio de costo cero).

## 3. Base de datos

**Decisión: SQLite se queda. Postgres/Neon sale del plan de lanzamiento.**

La migración a Neon+Drizzle era el ítem más caro del plan anterior (reescribir `db.js`, tests, y volver async los handlers de `server.js`) y sus dos argumentos se cayeron: los backups gestionados los da **Litestream** replicando `data/mikampus.db` a un bucket gratuito (backup continuo, point-in-time, un archivo de config); y "es tu stack" es preferencia, no beneficio del estudiante. SQLite en un server single-process con <50 usuarios es el caso de uso ideal de SQLite. Se migra a Postgres solo si aparece una necesidad real (segundo proceso, >50 usuarios). Agregar `user_id` a las tablas personales se hace en SQLite igual.

**Almacén de credenciales aparte [DECIDIDO]:** las credenciales nunca tocan `mikampus.db`. Viven en un archivo separado (`data/credentials.db` o equivalente), cifradas AES-256-GCM con clave solo en el `.env` del server, con las reglas de vida de §5. Separar el archivo separa también los backups: Litestream replica `mikampus.db`, el almacén de credenciales **no se respalda a ningún bucket** — si se pierde, los usuarios re-arman sus disparos; eso es una molestia, no una fuga.

### 3.1. Qué es privado y qué es compartido

Clasificación completa (la nota pedía investigarlo; esto sale de revisar tabla por tabla en `src/db.js`):

- **Compartido (sin `user_id`, lo sincroniza la cuenta de servicio):** `terms`, `subjects`, `courses`, `sections`, `seats_snapshot`, y **`pensum` re-modelado por carrera**. Hallazgo del audit: hoy el pénsum se scrapea del advisement report *personal*, pero el pénsum en sí es por carrera/versión — solo el progreso es privado. Separado en `pensum` (compartido, keyed por carrera) + `progress_items` (privado), el segundo estudiante de la misma carrera entra y ve su pénsum al instante, sin scrapear nada.
- **Privado (con `user_id`):** `grades`, `holds`, `enrollments` (su horario), `cart_rows`, `plans`, `progress_items`, `sync_log` (por usuario y tipo de dato), y las filas de watcher/schedule.

### 3.2. Política de datos: lazy loading con vida útil por tipo

La regla de la nota, vuelta política concreta. Los datos de un usuario **viven en DB indefinidamente** — nunca se borran por viejos, solo por orden explícita del dueño (§8). Cada tipo de dato tiene `synced_at` (la infraestructura ya existe en `sync_log`) y una vida útil acorde a su velocidad de cambio real:

| Dato | Vida útil | Por qué |
|---|---|---|
| Pénsum (compartido) / progreso | ~7 días | Cambia una vez por ciclo |
| Notas | ~24h (menos en finales) | Cambian en ráfagas conocidas |
| Horario inscrito, holds | ~12h | Cambian poco fuera de inscripción |
| Carrito | ~10 min | Es el objeto de trabajo en inscripción |
| Cupos (compartido) | ~60s, solo con watchers activos | Es la mercancía del watcher |

Al entrar, la app **muestra lo cacheado al instante** (con su "actualizado hace X", el patrón de honestidad de estado de PLAN.md §1.6) y refresca en background solo lo vencido y solo si hay sesión viva del usuario. La sincronización ocurre cuando: (1) primer login del usuario (el único sync "grande"), (2) mikampus mismo causó un cambio (inscribió, agregó al carrito → refresca lo afectado), (3) el usuario lo pide, (4) venció la vida útil y hay sesión con la que refrescar. Nunca "pantalla vacía esperando sync" salvo la primerísima vez — y esa primera vez se diseña: qué se sincroniza primero (horario → carrito → notas → progreso), qué ve mientras tanto, y que el pénsum compartido ya esté ahí si alguien de su carrera pasó antes.

**Refresh global, no por sección [NOTA §15 resuelta]:** los botones "traerlo de PeopleSoft" repartidos por pantalla desaparecen como *obligación*. Un solo **"Actualizar"** global (en el header/sidebar) refresca en una pasada todo lo vencido del usuario, en el orden de prioridad de arriba, mostrando progreso por el feed SSE que ya existe. Con la política de vida útil funcionando, ese botón se vuelve opcional: la app ya refresca sola lo que está viejo al entrar — el botón queda para el impaciente y para "acabo de cambiar algo en micampus directamente". Los botones por sección pueden quedarse como acción secundaria discreta ("actualizar solo esto"), pero nunca como requisito para ver datos.

## 4. Dominio

**Decisión: `mikampus.decruce.dev`**, A record a la VM de Oracle. Caddy emite el certificado solo. `.dev` → HSTS precargado, HTTPS obligatorio desde el día uno — con Caddy es gratis. La PWA (`web/public/manifest.webmanifest` + `sw.js`) por fin funciona fuera de localhost: contexto seguro real, instalable desde el teléfono.

---

## 5. Login y credenciales

**Decisión: el login de mikampus ES el login del portal — verificado contra PeopleSoft, con sesión propia por cookie. [DECIDIDO] Nosotros no guardamos credenciales... salvo la excepción mínima, cifrada y con autoborrado.**

No inventamos una cuenta paralela: el estudiante entra con sus credenciales de micampus, mikampus las verifica logueándose al portal (el flujo de `src/login.js` ya existe) y crea el usuario + una sesión propia (cookie HttpOnly + Secure, token en DB). Cero fricción: no "se registran", entran.

**Dónde vive la contraseña — las tres reglas:**

1. **Por defecto: solo en RAM.** Al entrar, la credencial viaja al server y vive en memoria, atada al context de Playwright del usuario. Sirve para todo el uso interactivo (sync, carrito, inscribir ahora). Cierra sesión o expira el context → se descarta. Nunca toca disco.
2. **Excepción: features desatendidas.** Programar el disparo de las 6:00am o activar el watcher con auto-inscripción requiere que el server pueda re-loguear sin el usuario presente. Solo entonces la credencial se escribe al almacén cifrado de §3 — **con consentimiento explícito en la UI** ("para inscribirte a las 6:00am necesito guardar tu contraseña cifrada hasta que se ejecute").
3. **Autoborrado.** La credencial persistida se borra apenas: se ejecuta el disparo, o el usuario desactiva el watcher/la programación, o borra sus datos (§8). El almacén de credenciales tiende a vacío; lleno solo alrededor del día de inscripción.

Esto sobrevive reinicios del server (el disparo de las 6am es a prueba de reboot, que era el punto débil de "solo RAM") sin convertir a mikampus en una bóveda permanente de contraseñas ajenas.

Además: pantalla de login con el disclaimer en cristiano (qué guardamos, cuándo, cómo borrarlo — enlaza con §8), y **rate-limit de intentos** (PeopleSoft bloquea cuentas por intentos fallidos; no ser el vector). **Detección de credencial inválida como estado propio:** si el portal rechaza la contraseña guardada (la cambió, venció), se distingue de un error transitorio — se desactivan sus timers, se borra la credencial y se le avisa por push *en el momento*, no silencio hasta que el disparo de las 6am falle mientras duerme.

## 5.5. Watcher y notificaciones

**Decisión [DECIDIDO]: al detectar cupo, notificar + auto-inscribir; toggle en Ajustes para "solo notificarme".**

- El watcher vigila las materias del carrito del usuario contra `seats_snapshot` — que es **compartido** y lo alimenta la cuenta de servicio cada ~60s cuando hay watchers activos. Un solo scrape de cupos sirve a todos los watchers: N usuarios no significan N lecturas del portal (hoy el tick de `scheduler.js:110-157` lee el carrito del usuario cada 45s; eso se reserva para lo que sí es privado).
- **El watcher vigila la materia, no solo la sección [NOTA §15 resuelta]:** si una sección del carrito está cerrada, el sync de la cuenta de servicio trae *todas* las secciones de esa materia en el término — y detecta dos cosas: cupo nuevo en la sección elegida, y **grupos nuevos creados** (la universidad abre secciones extra cuando hay demanda). Grupo nuevo con cupo → push "abrieron NRC 4521 de ICS-301 (Ma/Ju 9:00) — cámbialo en tu carrito" con deep-link para swapear la sección desde mikampus mismo. El dato ya está: el sync de secciones por materia existe (`classSearch.js`); es cuestión de diffear contra lo conocido.
- Cupo detectado → **Web Push inmediata** (VAPID + suscripciones sobre el service worker que la PWA ya tiene; gratis) y, si el usuario tiene auto-inscripción activa y credencial disponible (RAM o almacén cifrado), el server inscribe al instante. La push informa el resultado: "cupo en ICS-301, te inscribí ✓" o "cupo en ICS-301 — entrá a confirmar".
- El toggle "auto-inscribir cuando abra cupo" vive en Ajustes (§8), default activado; apagado = solo notificar con deep-link a Inscripción. Auto-inscribir con el usuario ausente requiere credencial persistida → aplica la regla 2 de §5 (consentimiento explícito al activarlo).

## 6. Landing page

**Decisión: hero público en `/` para visitantes; la app vive detrás del login.**

Ruta pública nueva (hoy `/` es el Dashboard, `web/src/App.tsx:17`): un hero en el tono del sistema de diseño existente (PLAN.md §3 — Bricolage Grotesque para display, voz de herramienta, sin humo). Título + una frase de valor, 3–4 features con capturas reales (el WeeklyGrid coloreado es la firma visual — protagonista), y un solo CTA: "Entrar a mikampus" → login. Logueado, `/` redirige al Dashboard. Al ser open source, la landing enlaza el repo — es parte del pitch de confianza: "no me creas a mí, lee el código".

Sin pricing, sin testimonios inventados, sin relleno: una pantalla, scroll corto.

---

## 7. Rework de UI

### 7.1 WeeklyGrid: las horas

El problema está en `web/src/components/WeeklyGrid.tsx:110-118`: las etiquetas de hora usan `hourRow(i)` con un hack de `relative -top-1.5` que se desalinea según la altura real de las filas. Arreglo: alinear la etiqueta a la línea de la hora por grid (`align-self: end` + `translate-y-1/2`), sin offsets mágicos. Mismo criterio para verificar que los bloques (`toGridLine` en `web/src/lib/grid.ts`) caigan exactamente sobre las hairlines.

### 7.2 Sidebar con iconos

`Layout.tsx:7-17` define `NAV` solo con labels. Se agrega un icono por sección con **lucide-react** (tree-shakeable, trazo consistente; ~1KB por icono): Inicio→`house`, Planear→`calendar-range`, Mi horario→`calendar-days`, Inscripción→`graduation-cap`, Notas y avance→`chart-line`, Ajustes→`settings`. En mobile (donde el nav ya desborda a dos líneas, `Layout.tsx:62-63`) los iconos permiten labels cortos o icon-only con `aria-label`.

### 7.3 Cero emojis, solo iconos

Inventario (grep sobre `web/src`): `ThemeToggle.tsx:18` 🌙/☀️ → `moon`/`sun`; `Builder.tsx:359` 🔒/🔓 → `lock`/`lock-open`; `Builder.tsx:223,294,398`, `Planner.tsx:559,571`, `Buscar.tsx:208,238` ✓/✗/▾ → `check`/`x`/`chevron-down`; `Planner.tsx:77` ▲/▼ → `chevron-up`/`chevron-down`. Regla para el futuro: ningún glifo decorativo en JSX; todo estado visual es un icono de lucide o un token de color del sistema.

### 7.4 Alcance del rework

Solo lo que lo necesita: WeeklyGrid (horas), Layout (iconos + nav), y las pantallas de §9–§12. Dashboard, Académico y el sistema de tokens actuales no se tocan por tocar.

---

## 8. Ajustes robusta

La página actual (`web/src/routes/Ajustes.tsx`) es solo "cambiar de cuenta" — que desaparece: con login real, cambiar de cuenta es cerrar sesión. La página nueva:

1. **Cuenta** — quién sos (solo lectura) y **Cerrar sesión** (mata cookie + context de Playwright + credencial en RAM; el teardown ya existe en `resetSession()`, `session.js:53`).
2. **Preferencias** — el toggle de tema (hoy huérfano en el sidebar, `Layout.tsx:88`) y el **toggle de auto-inscripción del watcher** (§5.5): "cuando abra un cupo: inscribirme al instante / solo avisarme".
3. **Tus datos** — la importante: lista *qué* guardamos (con fecha de último sync por tipo, de `sync_log`), **si hay una credencial cifrada guardada ahora mismo y por qué** ("guardada hasta tu disparo del 20/07 6:00am" — transparencia total sobre la excepción de §5), y el botón **"Borrar todos mis datos"**: elimina sus filas, su credencial, cierra sesión y lo devuelve a la landing. Solo borra lo nuestro — su cuenta de micampus no se toca, y el texto lo dice explícito. Confirmación con fricción: es irreversible.

---

## 9. Unificar Inicio + Holds

**Decisión: Holds deja de ser sección; se funde en el Dashboard.**

`Holds.tsx` son 88 líneas sin severidad (el portal no la publica, `Holds.tsx:7-10`). El Dashboard ya consulta holds (`Dashboard.tsx:42`). Se convierte en card del aside junto a `NextCycleCard`: verde "sin holds" cuando el vacío está verificado, lista compacta con link a micampus cuando hay, CTA de sincronizar cuando nunca se miró (los tres estados que `Holds.tsx` ya distingue — esa lógica se mueve, no se reescribe). `/holds` redirige a `/`.

## 10. Builder + Planner: unificar

**Decisión: una sola sección "Planear" con dos vistas del mismo plan.**

Comparten carga de planes, `CourseSearchBox`, `WeeklyGrid`, `CourseChip`, `SeatBadge`, `LiveOpBanner` y el envío al carrito (imports casi idénticos en `Planner.tsx:1-32` y `Builder.tsx:1-27`). La diferencia real: **Planner decide QUÉ materias, Builder decide QUÉ SECCIONES** — dos pasos del mismo flujo, no dos features. Ruta única `/planear` con el plan como contexto persistente y dos tabs — **"Materias"** y **"Horario"** (Builder precargado vía `loadPlan`, `Builder.tsx:72-80`). Un solo "Enviar al carrito" al nivel del plan.

**[DECISIÓN TUYA]** — recorte de scope visible para el usuario; confirmalo antes de implementar.

## 11. Rework de Inscripción

El problema de `Inscripcion.tsx` es de jerarquía, no de features: carrito, hora programada, watcher, botón manual y feed conviven sin decirle al estudiante **dónde está parado**. Rediseño alrededor de un **estado maestro** visible arriba de todo:

1. **Preparando** — carrito con problemas o vacío: choques (el WeeklyGrid de `Inscripcion.tsx:141` sube: es el chequeo, no un extra), secciones cerradas, holds pendientes. Cada problema con su acción.
2. **Armado** — carrito listo, falta decidir el disparo: programar hora (countdown de `Countdown.tsx` central) o watcher. Con los appointments por estudiante (Fase 0.3): si el portal publica la hora del usuario, "Armado" la propone en un click en vez de pedirle escribirla.
3. **En vivo** — `LiveOpBanner` + `ActivityFeed` toman la pantalla, paso a paso (honestidad de estado, PLAN.md §1.6).
4. **Resultado** — qué entró y qué no, materia por materia, con siguiente acción para las que fallaron.

"Inscribir ahora" pasa de botón gris al fondo (`Inscripcion.tsx:205-211`) a acción primaria: es LA acción de la pantalla.

**Búsqueda consciente del ciclo [NOTA §15 resuelta]:** Inscripción gana un `CourseSearchBox` propio para agregar al carrito sin cambiar de pantalla — pero no una búsqueda ciega. mikampus sabe para qué ciclo estás inscribiendo y qué te toca cursar: el cruce de pénsum (§3.1) + progreso + lo ofertado en el término ya existe como lógica de "pendientes" en Planner. Antes de escribir una letra, el buscador muestra **"lo que deberías cursar este ciclo"** ordenado primero (pendientes del pénsum ofertados en el término, con cupo), y la búsqueda libre debajo. Es la diferencia entre un buscador y un asesor.

## 12. Buscar: fuera del sidebar

**Decisión: `/buscar` desaparece como sección; la búsqueda vive donde se usa, ⌘K es la búsqueda global.**

El usuario solo busca materias cuando planifica, arma horario o inscribe — Planner y Builder ya tienen `CourseSearchBox`; `/buscar` es la única pantalla donde buscar es el fin y no el medio. La dirección:

- La ficha de secciones con "Agregar al carrito" (`Buscar.tsx:208`) y "Al plan" (`Buscar.tsx:238`) no se pierde: se convierte en un **panel de detalle de materia** reutilizable, abrible desde cualquier `CourseSearchBox` y desde ⌘K.
- **⌘K (`CommandPalette.tsx`) es la búsqueda global**: navegar secciones + buscar materias (índice MiniSearch ya en cliente) → abre el panel de detalle. El botón "Buscar…" del sidebar (`Layout.tsx:53-60`) queda como puerta al palette.
- Inscripción gana su buscador consciente del ciclo (§11).
- `/buscar` redirige al Dashboard.

Sidebar resultante (§9 + §10 + §12): de 9 entradas a **6** — Inicio, Planear, Mi horario, Inscripción, Notas y avance, Ajustes. Cada una con icono, ninguna redundante.

---

## 13. Riesgos que este documento no puede cerrar

El riesgo número uno sigue siendo la **relación con el portal**: aunque ya casi no custodiamos credenciales (§5 lo reduce a una ventana cifrada con autoborrado), el server concentra el scraping de N estudiantes — y tu cuenta de servicio absorbe la parte compartida. Mitigación: rate-limits conservadores, no scrapear nada que ningún usuario pidió, cupos solo con watchers activos, y la prueba de IP de Fase 0 antes de todo. El dos es **PeopleSoft cambia** (un selector roto rompe a todos a la vez, y MFA rompería el modo desatendido): hace falta que el server te avise *a vos* cuando algo falla repetido — un canal de alerta al operador (push a tu teléfono), porque a las 6:00am el único que puede reaccionar sos vos. El tres es **el día-D**: N logins simultáneos sobre el pool de contexts se prueban con antelación, con detección de crash del Chromium compartido y relanzamiento. Y el cuatro es **Oracle**: el free tier es generoso pero es de Oracle — monitorear que no reclame la VM, y tener el plan B (tu máquina + Cloudflare Tunnel) documentado y probado, no teórico.

## 14. Orden propuesto

Cada fase en su rama, como siempre:

0. **Fase 0 — validar supuestos** (§0.5): VM de Oracle gratis + `loginToPeopleSoft` desde ahí; confirmar appointments por estudiante y estado de MFA. Una tarde-un día; puede invalidar decisiones de abajo, por eso va primero.
1. **Walking skeleton hosted** — la app actual, single-user, corriendo en la VM con Docker + Caddy + basic auth provisional + Litestream. Vos como único usuario real una semana desde el teléfono. Valida RAM, IP, PWA y operación antes del big bang multi-usuario.
2. **Multi-usuario de base** — `user_id` en tablas personales sobre SQLite, pénsum re-modelado por carrera (§3.1), pool de contexts por usuario + cuenta de servicio (§1), auth + cookie de sesión, credenciales RAM + almacén cifrado con autoborrado (§5), timers persistidos.
3. **Login + landing + Ajustes** — las tres pantallas del ciclo de cuenta (§5, §6, §8), lazy loading con vida útil + refresh global (§3.2) y la experiencia de primer sync.
4. **Watcher + push** — Web Push (VAPID), watcher sobre cupos compartidos + detección de grupos nuevos, auto-inscripción con toggle (§5.5), alerta al operador (§13).
5. **Consolidación de navegación** — Holds→Dashboard, Planner+Builder→Planear, adiós /buscar, sidebar con iconos (§7.2, §9, §10, §12).
6. **Rework visual** — WeeklyGrid, emojis→iconos, Inscripción con estado maestro y buscador consciente del ciclo (§7.1, §7.3, §11).
7. **Lanzamiento** — DNS definitivo, prueba de carga del día-D, invitar a los primeros compañeros.
