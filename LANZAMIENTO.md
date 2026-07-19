# LANZAMIENTO.md — de herramienta personal a plataforma para compañeros

> Audit de decisiones para llevar mikampus a producción en `mikampus.decruce.dev`, con login por estudiante y datos aislados por usuario. Cada decisión está anclada al código actual. v3: incorpora el segundo audit — pre-warming del disparo, la costura sesión/credencial, vida de credencial por ventana de inscripción, fairness entre watchers, presupuesto de scraping, audit log, y el supuesto `TARGET_TERM` que faltaba en el diagnóstico. Las notas de Elias de v2 que quedaban abiertas están resueltas en el texto.

**Principios que ordenan todo el documento** (salen de las notas, no son decoración):

1. **Costo cero.** El piloto hosted se paga con el crédito del GitHub Student Developer Pack; no se activa facturación fuera de ese crédito. Antes de su vencimiento se decide entre migrar a una alternativa gratis o volver al modo local. Nada de planes pagos "baratos" por inercia.
2. **Open source, y corre local.** El repo es público y cualquiera puede correr mikampus completo en su máquina (modo single-user, el comportamiento actual). El deploy hosted es *una* instancia de eso, no un fork.
3. **Las credenciales no viven en la DB principal, jamás.** Solo se persisten —cifradas, en un almacén aparte— cuando una feature desatendida lo exige, y se borran cuando deja de exigirlo.
4. **La app es inteligente con los datos:** muestra lo cacheado al instante, refresca solo lo vencido, nunca borra por expirar, nunca obliga a sincronizar para poder mirar.
5. **El disparo es sagrado.** A la hora de inscripción, el submit ya está armado: sesión logueada, asistente navegado, solo falta el click. Todo lo demás (crons, syncs, catálogo) cede el paso. Un catálogo viejo se arregla mañana; una inscripción perdida espera un cuatrimestre.

---

## 0. Diagnóstico: qué asume "un solo usuario" hoy

Todo el backend está construido sobre la premisa de una sola persona. Estos son los puntos exactos que hay que romper para el multi-usuario:

- **Una sola sesión de Playwright global.** `src/session.js:1-27` mantiene `browser`/`page` como variables de módulo y `withPage()` encola todas las acciones en una única fila. Con dos usuarios, el segundo scrapearía con la sesión del primero. *(La pregunta de la nota — ¿aguanta un solo Chromium a 10 estudiantes? — está respondida en §1: sí, con contexts; los cuellos reales son otros.)*
- **`withPage` reintenta a ciegas.** `session.js:37-41` re-ejecuta `fn` completa ante *cualquier* error — incluidos errores lógicos que van a volver a fallar (a escala N eso duplica carga contra el portal) y, peor, un timeout a mitad de un enroll reintenta el asistente entero. El retry tiene que distinguir "sesión muerta" (reintentar) de "el portal respondió algo" (no reintentar), y las operaciones con efectos (enroll, add-to-cart) son no-reintenables por defecto.
- **Una sola cuenta del portal.** `src/credentials.js` lee `data/account.json` o el `.env` — la contraseña vive en texto plano en disco. Válido para modo local; inaceptable en el server hosted (ver §5, dónde vive cada credencial).
- **El término vive en el `.env`.** `TARGET_TERM` gobierna `server.js:31` y `cron.js:27`, y es el default de `/api/my-schedule`, `/api/pensum` y `/api/requirements`. Con N usuarios (grado y posgrado con calendarios distintos) el término es por-usuario o por-request, nunca por-proceso.
- **Datos personales sin dueño.** En `src/db.js`, las tablas `grades`, `holds`, `enrollments`, `cart_rows`, `plans`, `progress_items` no tienen columna de usuario. Cada una necesita `user_id`. `pensum` es un caso especial: es compartido por carrera, no personal (ver §3.1).
- **Scheduler y watcher globales.** `src/scheduler.js` y `src/cron.js` asumen un único disparo programado y un único watcher. Cada estudiante necesita los suyos, persistidos en DB (si el server se reinicia a las 5:59am, el disparo de las 6:00 tiene que sobrevivir — hoy viven en memoria, `scheduler.js:29-32`). El inventario completo de qué corre programado y cuándo está en §5.7 — nada se agenda "a ciegas".
- **Cero auth en el server.** `src/server.js` sirve `/api/*` sin autenticación. Bloqueante absoluto para deploy.

## 0.5. Fase 0 — verificar antes de construir

Cuatro supuestos pueden invalidar la arquitectura entera y se comprueban en una tarde cada uno, **antes** de escribir una línea de multi-usuario:

1. **¿Micampus acepta tráfico desde la IP de DigitalOcean?** El piloto vive en un datacenter extranjero; portales universitarios a veces bloquean o degradan tráfico no-residencial. Prueba: levantar el Droplet y correr `loginToPeopleSoft` desde ahí. Si falla, el plan hosted se detiene y el producto queda en modo local open source. La prueba incluye el caso feo: **varios logins seguidos desde esa misma IP** (el patrón real de las 5:55am, ver §5.6) — un login que pasa y cinco que disparan un WAF son resultados distintos.
2. **¿El portal tiene o anuncia MFA?** Toda la arquitectura de re-login desatendido asume que usuario+contraseña bastan. Verificado: **no tiene MFA** — credenciales y estás adentro. Queda diseñar el mensaje de fallo para el día que cambie.
3. **¿La hora de inscripción es la misma para todos?** Verificado: **es por escuela** — todos los de ingeniería a la misma hora, cada carrera con la suya. Consecuencias: (a) el pico de las 6:00am es real y concentrado (tus usuarios son mayormente de la misma escuela → misma hora exacta); (b) mikampus debería **leer/conocer el appointment por escuela y proponerle al usuario programar su hora** en un click; (c) el watcher tiene que ser appointment-aware (§5.5).
4. **¿Podemos cambiar de término a voluntad?** El sync multi-término de la cuenta de servicio depende del botón **Change Term** del portal, que todavía no tiene fixture ni flujo probado (recon pendiente de Fase 6 del PLAN). Y el class search **corta en 50 resultados** por búsqueda. Las dos cosas acotan qué puede prometer el loop de cupos (§5.5) — se verifican antes de prometer nada multi-término.

---

## 1. Arquitectura multi-usuario

**Decisión: server único de larga vida con pool de sesiones Playwright por usuario + una sesión de servicio para lo compartido.**

- `withPage(fn)` pasa a `withPage(userId, fn)`: un mapa `userId → { context, page, queue }` usando **browser contexts** de un solo Chromium compartido (un context por usuario aísla cookies/sesión del portal). Contexts inactivos se cierran tras N minutos; el patrón de re-login ya existe en `ensureSession()`.
- **Resolución de la nota "un solo Chromium es una locura":** no lo es, y la objeción apuntaba al lugar equivocado. Un context por usuario con **su propia cola** significa que la lentitud de un usuario nunca encola a otro — el miedo a "colas larguísimas" era un artefacto de la fila única actual, que justamente desaparece. Los cuellos reales son dos: (a) **la cola única de la cuenta de servicio** (ver el presupuesto de scraping en §5.5) y (b) **CPU a las 6:00am**: 10-15 páginas de PeopleSoft cargando frames simultáneamente sobre 4 OCPU ARM sí puede saturar. Lo segundo se mide en la prueba de carga (§13) y lo amortigua el pre-warming (§5.6), que despacha los logins *antes* del pico con jitter.
- Además del retry inteligente de §0: cola por usuario + límite global de contexts concurrentes.
- **Sesión de servicio [DECIDIDO]:** la cuenta de Elias actúa como cuenta de servicio para el sync compartido (catálogo, secciones, cupos, pénsums por carrera). Los estudiantes se benefician sin exponer sus sesiones; la visibilidad del scraping de fondo la absorbe una sola cuenta. Su context es uno más del pool, con su propia cola.
- El watcher y la hora programada se vuelven **filas por usuario en DB** (persistidas, no en memoria).
- Un crash del Chromium compartido tumba a todos los contexts a la vez: el pool necesita detección de crash + relanzamiento, y el día-D se prueba con N logins simultáneos antes, no ese día (§13).

**Costo real:** cada context activo son ~80–150MB. El piloto arranca en un Droplet de 2GB/1 vCPU para un usuario; antes de invitar compañeros se mide el pico y se sube a 4GB/2 vCPU si hace falta. El límite será CPU en la hora de inscripción, no la arquitectura de contexts.

## 2. Deploy

**Decisión [DECIDIDO]: DigitalOcean Droplet + Docker + Caddy para el piloto hosted. El proyecto es open source y corre completo en local.**

- El crédito de US$200 del GitHub Student Developer Pack financia el piloto; se reclama antes de su vencimiento y no se agrega tarjeta/facturación de pago. Es una ventana de validación, no una promesa de hosting gratis permanente.
- Docker con la imagen oficial de Playwright, `docker compose` con server + volumen de datos, **Caddy** como reverse proxy con TLS automático. El Droplet puede ser x86_64: no hay dependencia de ARM en el deploy.
- **`TZ=America/Santo_Domingo` fijado en el contenedor, con un test.** El Droplet vive en una región extranjera; `cron.js:44-48` calcula "las 03:00" en hora local del sistema y `scheduleFixedTime` confía en el ISO del cliente. Sin el TZ fijado, "6:00am" es el bug clásico de dispara-a-las-2am. NTP activo por la misma razón: el disparo compite por segundos.
- Riesgos del piloto: (a) termina el crédito estudiantil — se revisa el saldo y fecha de vencimiento cada mes, sin upgrade automático; (b) la IP de datacenter — se valida en Fase 0. **Plan B:** modo local open source; no se promete un hosted permanente antes de superar esa revisión.
- **Modo local:** el repo mantiene el modo actual single-user (`npm run dev` / futuro `npx mikampus`): credenciales en `.env`/`account.json` local, sin auth, sin multi-usuario. Es el mismo código con `MODE=local` — no un fork. Esto es lo que hace honesto el "open source": cualquiera puede auditarlo y correrlo sin confiar en el server de nadie.

Descartados: Vercel/serverless (Playwright + SSE + scheduler no caben en funciones), Railway/Fly (RAM para Chromium se paga), VPS pago (viola el principio de costo cero).

## 3. Base de datos

**Decisión: SQLite se queda. Postgres/Neon sale del plan de lanzamiento.**

La migración a Neon+Drizzle era el ítem más caro del plan anterior (reescribir `db.js`, tests, y volver async los handlers de `server.js`) y sus dos argumentos se cayeron: los backups gestionados los da **Litestream** replicando `data/mikampus.db` a un bucket gratuito (backup continuo, point-in-time, un archivo de config); y "es tu stack" es preferencia, no beneficio del estudiante. SQLite en un server single-process con <50 usuarios es el caso de uso ideal de SQLite. Se migra a Postgres solo si aparece una necesidad real (segundo proceso, >50 usuarios). Agregar `user_id` a las tablas personales se hace en SQLite igual.

**Los backups guardan datos de terceros — con reglas:** el bucket de Litestream contiene notas y expedientes de compañeros, en una cuenta tuya. Tres reglas: el bucket va **cifrado**, la **retención es corta** (~72h de point-in-time: suficiente para desastres, no un archivo histórico), y el texto de "Borrar mis datos" (§8) dice la verdad sobre esa ventana. **[DECISIÓN TUYA]** — la promesa exacta al usuario: "tus datos salen de los backups en ≤3 días" (retención corta, honesto y simple) vs. borrado inmediato también en backups (caro de implementar, frágil). Recomendación: la primera.

**Almacén de credenciales aparte [DECIDIDO]:** las credenciales nunca tocan `mikampus.db`. Viven en un archivo separado (`data/credentials.db` o equivalente), cifradas AES-256-GCM con clave solo en el `.env` del server, con las reglas de vida de §5. Separar el archivo separa también los backups: Litestream replica `mikampus.db`, el almacén de credenciales **no se respalda a ningún bucket** — si se pierde, los usuarios re-arman sus disparos; eso es una molestia, no una fuga.

**Migración de lo que ya existe:** la Fase 2 no arranca de cero — `data/mikampus.db` tiene los datos reales de Elias y ~30 scripts en `scripts/test-*.mjs` están escritos contra el esquema single-user. La migración **adopta las filas existentes como el usuario 1** (un UPDATE por tabla personal, reversible), y los scripts de test se adaptan en la misma fase — son la única red de seguridad durante la reescritura más grande del proyecto, no pueden quedar rotos "para después".

### 3.1. Qué es privado y qué es compartido

Clasificación completa (la nota pedía investigarlo; esto sale de revisar tabla por tabla en `src/db.js`):

- **Compartido (sin `user_id`, lo sincroniza la cuenta de servicio):** `terms`, `subjects`, `courses`, `sections`, `seats_snapshot`, y **`pensum` re-modelado por carrera**. Hallazgo del audit: hoy el pénsum se scrapea del advisement report *personal*, pero el pénsum en sí es por carrera/versión — solo el progreso es privado.
- **El pénsum compartido se construye desde un documento personal — y eso tiene truco.** El advisement report **colapsa las electivas ya satisfechas y oculta sus candidatas** (el esquema ya lo modela: `requirement_groups.collapsed`, `db.js:98`), y los grupos traen stats personales (`units_taken`, `gpa_actual`). O sea: el árbol scrapeado de un estudiante de término alto es *más pobre* que el de un freshman de la misma carrera. El pénsum compartido se keyea por **carrera + `pensum_no`**, se le quitan los campos personales, y en cada sync se hace **merge conservador por grupo**: un grupo con candidatas visibles nunca se pisa con la versión colapsada del mismo grupo. Y honestidad sobre el beneficio: el *progreso* del segundo estudiante igual requiere su propio advisement scrape — lo que el pénsum compartido compra es poder navegar la carrera antes del primer sync, no ahorrarse el scrape.
- **Privado (con `user_id`):** `grades`, `holds`, `enrollments` (su horario), `cart_rows`, `plans`, `progress_items`, `sync_log` (por usuario y tipo de dato), las filas de watcher/schedule, y **`action_log`** (§8: cada acción que mikampus ejecutó sobre su matrícula, con timestamp y respuesta del portal).

### 3.2. Política de datos: lazy loading con vida útil por tipo

La regla de la nota, vuelta política concreta. Los datos de un usuario **viven en DB indefinidamente** — nunca se borran por viejos, solo por orden explícita del dueño (§8). Cada tipo de dato tiene `synced_at` (la infraestructura ya existe en `sync_log`) y una vida útil acorde a su velocidad de cambio real:

| Dato | Vida útil | Por qué |
|---|---|---|
| Pénsum (compartido) / progreso | ~7 días | Cambia una vez por ciclo |
| Notas | ~24h (menos en finales) | Cambian en ráfagas conocidas |
| Horario inscrito, holds | ~12h | Cambian poco fuera de inscripción |
| Carrito | ~10 min | Es el objeto de trabajo en inscripción |
| Cupos (compartido) | el intervalo que dé el presupuesto de §5.5, solo con watchers activos | Es la mercancía del watcher |

Al entrar, la app **muestra lo cacheado al instante** (con su "actualizado hace X", el patrón de honestidad de estado de PLAN.md §1.6) y refresca en background solo lo vencido — **si tiene con qué**: refrescar exige credencial viva, y la sesión de mikampus vive más que la credencial en RAM (la costura completa en §5.1; la UI tiene un estado explícito para "vencido y sin credencial"). La sincronización ocurre cuando: (1) primer login del usuario (el único sync "grande"), (2) mikampus mismo causó un cambio (inscribió, agregó al carrito → refresca lo afectado), (3) el usuario lo pide, (4) venció la vida útil y hay credencial con la que refrescar. Nunca "pantalla vacía esperando sync" salvo la primerísima vez — y esa primera vez se diseña: qué se sincroniza primero (horario → carrito → notas → progreso), qué ve mientras tanto, y que el pénsum compartido ya esté ahí si alguien de su carrera pasó antes.

**Refresh global, no por sección [NOTA §15 resuelta]:** los botones "traerlo de PeopleSoft" repartidos por pantalla desaparecen como *obligación*. Un solo **"Actualizar"** global (en el header/sidebar) refresca en una pasada todo lo vencido del usuario, en el orden de prioridad de arriba, mostrando progreso por el feed SSE que ya existe. Con la política de vida útil funcionando, ese botón se vuelve opcional: la app ya refresca sola lo que está viejo al entrar — el botón queda para el impaciente y para "acabo de cambiar algo en micampus directamente". Los botones por sección pueden quedarse como acción secundaria discreta ("actualizar solo esto"), pero nunca como requisito para ver datos.

## 4. Dominio

**Decisión: `mikampus.decruce.dev`**, A record a una Reserved IP asignada al Droplet de DigitalOcean. Caddy emite el certificado solo. `.dev` → HSTS precargado, HTTPS obligatorio desde el día uno — con Caddy es gratis. La PWA (`web/public/manifest.webmanifest` + `sw.js`) por fin funciona fuera de localhost: contexto seguro real, instalable desde el teléfono.

---

## 5. Login y credenciales

**Decisión: el login de mikampus ES el login del portal — verificado contra PeopleSoft, con sesión propia por cookie. [DECIDIDO] Nosotros no guardamos credenciales... salvo la excepción mínima, cifrada y con vida acotada a la ventana de inscripción.**

No inventamos una cuenta paralela: el estudiante entra con sus credenciales de micampus, mikampus las verifica logueándose al portal (el flujo de `src/login.js` ya existe) y crea el usuario + una sesión propia (cookie HttpOnly + Secure + **SameSite** — toda la API es JSON mutante con cookie; sin SameSite/CSRF-token el auth es decorativo). Cero fricción: no "se registran", entran.

**El registro está gateado por invitación.** Login = credenciales del portal significa que *cualquier* estudiante PUCMM podría entrar — y el dimensionamiento entero ("10-20 compañeros") sería una esperanza, no un límite. Un allowlist de usernames (o códigos de invitación) convierte la suposición en garantía y es la defensa del principio de costo cero. Trivial de implementar, imprescindible antes del DNS público.

**Dónde vive la contraseña — las tres reglas:**

1. **Por defecto: solo en RAM.** Al entrar, la credencial viaja al server y vive en memoria, atada al context de Playwright del usuario. Sirve para todo el uso interactivo (sync, carrito, inscribir ahora). Cierra sesión o expira el context → se descarta. Nunca toca disco.
2. **Excepción: features desatendidas.** Programar el disparo de las 6:00am o activar el watcher con auto-inscripción requiere que el server pueda re-loguear sin el usuario presente. Solo entonces la credencial se escribe al almacén cifrado de §3 — **con consentimiento explícito en la UI** y con la vida de la regla 3 dicha en el mismo diálogo.
3. **Vida acotada a la ventana de inscripción, con expiración visible.** La versión anterior ("se borra apenas se ejecuta el disparo") la rompía la realidad la primera mañana: el disparo corre a las 6:00, dos materias entran, una falla — y el usuario quiere el watcher *ya*, no re-consentir y re-tipear a las 6:05 mientras los cupos vuelan. Y el watcher, además, no tiene fecha de fin natural. La regla honesta: la credencial persistida vive **hasta que cierre la inscripción del término o hasta que el usuario la borre/desactive todo — lo que ocurra primero**, y Ajustes (§8) muestra siempre la fecha exacta ("guardada hasta que cierre la inscripción de Sept-2026"). El almacén sigue tendiendo a vacío el resto del año; lleno solo alrededor de inscripción, que es exactamente cuando se necesita.

Esto sobrevive reinicios del server (el disparo de las 6am es a prueba de reboot) sin convertir a mikampus en una bóveda permanente de contraseñas ajenas.

Además: pantalla de login con el disclaimer en cristiano (qué guardamos, cuándo, cómo borrarlo — enlaza con §8), y **rate-limit de intentos** (PeopleSoft bloquea cuentas por intentos fallidos; no ser el vector). **Detección de credencial inválida como estado propio:** si el portal rechaza la contraseña guardada (la cambió, venció), se distingue de un error transitorio — se desactivan sus timers, se borra la credencial y se le avisa por push *en el momento*, no silencio hasta que el disparo de las 6am falle mientras duerme. Cambio de contraseña detectado también **revoca las sesiones de mikampus** de ese usuario.

### 5.1. La costura sesión/credencial

La cookie de mikampus y la credencial en RAM tienen vidas distintas, y el hueco entre las dos es un estado de primera clase, no un edge case: la cookie vive días; el context de Playwright (y la contraseña en RAM atada a él) expira en minutos u horas, o muere con un reinicio del server. Resultado frecuente: un usuario *logueado en mikampus* cuya contraseña no existe en ningún lado. Todo §3.2 ("refresca solo lo vencido") depende de tener con qué refrescar.

Diseño: la cookie es **larga** (la app abre al instante con lo cacheado — principio 4) y la UI distingue tres estados: **(a)** credencial viva → refresco automático normal; **(b)** sin credencial, nada vencido-crítico → todo se ve, con sus StalenessTags; **(c)** sin credencial y hay que refrescar o actuar → un prompt único no bloqueante: "necesito tu contraseña de nuevo para traer datos frescos" (re-tipeo → vuelve a RAM y sigue). Nunca un logout sorpresa, nunca una pantalla congelada sin explicación. Si hay credencial en el almacén cifrado (regla 2 activa), el estado (c) no existe para ese usuario: el server la usa también para los refrescos.

## 5.5. Watcher y notificaciones

**Decisión: watcher default "solo notificar"; auto-inscribir es opt-in con consentimiento.** *(v2 decía "default activado"; contradecía la regla 2 de §5 — auto-inscribir con el usuario ausente ES persistir la credencial, y eso jamás puede ser un default silencioso. El toggle en Ajustes queda, pero activarlo es lo que dispara el diálogo de consentimiento.)*

- El watcher vigila las materias del carrito del usuario contra `seats_snapshot` — que es **compartido** y lo alimenta la cuenta de servicio cuando hay watchers activos. Un solo scrape de cupos sirve a todos los watchers: N usuarios no significan N lecturas del portal (hoy el tick de `scheduler.js:110-157` lee el carrito del usuario cada 45s; eso se reserva para lo que sí es privado).
- **El presupuesto de scraping manda sobre el intervalo prometido.** Cada lectura de secciones de una materia es una navegación completa de class search (~10-15s), y la cuenta de servicio es *un* context con *una* fila — con 8-10 materias vigiladas distintas, una pasada son 100-150s: los "~60s" de v2 eran matemáticamente imposibles. La regla: el intervalo real = (materias vigiladas distintas × costo por materia) + margen, la UI muestra el intervalo vigente en vez de prometer uno fijo, y el pico se acota priorizando las materias con más watchers. Con 10-20 usuarios de la misma escuela (materias solapadas) probablemente da ~60-90s; se mide, no se promete. Dependencias verificadas en Fase 0.4: Change Term y el límite de 50 resultados.
- **El watcher vigila la materia, no solo la sección [NOTA §15 resuelta]:** si una sección del carrito está cerrada, el sync de la cuenta de servicio trae *todas* las secciones de esa materia en el término — y detecta dos cosas: cupo nuevo en la sección elegida, y **grupos nuevos creados** (la universidad abre secciones extra cuando hay demanda). Grupo nuevo con cupo → push "abrieron NRC 4521 de ICS-301 (Ma/Ju 9:00) — cámbialo en tu carrito" con deep-link para swapear la sección desde mikampus mismo. El dato ya está: el sync de secciones por materia existe (`classSearch.js`); es cuestión de diffear contra lo conocido.
- **Appointment-aware:** un cupo detectado *antes* de la hora de inscripción del usuario no dispara auto-enroll — el portal lo va a rechazar y el intento quema segundos y sesión. Antes de tu hora: solo notificar ("hay cupo en ICC-301; tu inscripción abre a las 2pm — el watcher lo intentará entonces si sigue"). Después: auto-inscribir normal. La hora por escuela sale de Fase 0.3.
- Cupo detectado → **Web Push inmediata** (VAPID + suscripciones sobre el service worker que la PWA ya tiene; gratis) y, si el usuario tiene auto-inscripción activa y credencial disponible (RAM o almacén cifrado), el server inscribe. La push informa el resultado: "cupo en ICS-301, te inscribí ✓" o "cupo en ICS-301 — entrá a confirmar". Dos verdades incómodas de push que el onboarding absorbe: en **iOS solo funciona con la PWA instalada** al home screen (la instalación es un paso del onboarding, no un nice-to-have), y a las 6am el teléfono está en No Molestar — la push del resultado es informativa; lo accionable se diseñó antes (§5.6).
- **Un cupo, N watchers: la carrera interna [DECIDIDO].** `seats_snapshot` compartido significa que cuando abre 1 asiento, todos los que lo vigilan se enteran en el mismo tick. Los auto-enrolls se **serializan en una cola FIFO por orden de activación del watcher** (nunca N asistentes de inscripción simultáneos por un asiento — el portal evalúa cada carrito completo y eso es carga inútil y visible). La UI muestra la posición del usuario cuando haya conflicto — por ejemplo, "tu posición en la fila de ICC-301: 2º". Es una política transparente y explicable; el orden se persiste para que un reinicio no lo altere.

### 5.6. El disparo: pre-warming

El hallazgo más caro del audit: **tal como está codificado, el disparo de "las 6:00am" somete a las ~6:01.** `enrollFromCart` (`enroll.js:13-28`) carga el carrito y tiene ~17s de esperas fijas entre pasos, y `runEnrollNow` pasa por `ensureSession()` — que si no hay sesión viva hace el login completo (~30-40s con los saltos de frames de `login.js:51-67`). El timer dispara puntual (`scheduler.js:92`) y el "Finish Enrolling" llega un minuto tarde. Con toda tu escuela entrando a la misma hora exacta (Fase 0.3), ese minuto es cupo o waitlist.

**Pre-warming:** para cada disparo programado, el server arranca a **T-8 minutos con jitter por usuario** (5:52, 5:54, 5:55…): re-loguea el context (con la credencial del almacén), navega el asistente hasta dejar el submit final a un click, y a **T0 exacto** ejecuta solo ese click. El jitter, además de repartir CPU, evita el patrón "N logins el mismo segundo desde la misma IP de datacenter" que un WAF marca solo (se valida en Fase 0.1). Si el pre-warm de un usuario falla (credencial inválida, portal caído), hay 8 minutos para el reintento y para avisarle por push *antes* de su hora — no después. Reloj: NTP + `TZ` fijado (§2).

### 5.7. Inventario de lo programado

Respuesta a la nota "qué se ejecuta en los schedulers y a qué hora" — esto es *todo* lo que corre solo, y nada más:

- **Por usuario:** (1) el disparo a hora fija — pre-warm a T-8min, submit a T0, una fila en DB que se borra al ejecutarse; (2) el watcher — un registro en DB; no scrapea él mismo, reacciona a `seats_snapshot`.
- **Cuenta de servicio:** (3) el loop de cupos — solo mientras exista ≥1 watcher activo, al intervalo del presupuesto de §5.5; (4) el catalog cron nocturno (ya existe, `cron.js`) — **su guarda actual se reescribe**: hoy `blockedBecause()` se abstiene si hay *un* watcher, y con N usuarios siempre habrá alguno; la regla nueva es por colisión real: nunca durante pre-warms ni disparos (principio 5), y fuera de eso corre a su hora nocturna aunque haya watchers, compartiendo la cola de servicio; (5) el diff de grupos nuevos — dentro del mismo loop de cupos, no es un job aparte.

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
2. **Preferencias** — el toggle de tema (hoy huérfano en el sidebar, `Layout.tsx:88`) y el **toggle de auto-inscripción del watcher** (§5.5): "cuando abra un cupo: inscribirme al instante / solo avisarme" (activar el primero dispara el consentimiento de §5).
3. **Historial** — el **audit log**: cada acción que mikampus ejecutó sobre tu matrícula, con timestamp y respuesta literal del portal ("20/07 06:00:04 — inscribí ICC-301 NRC 4521 ✓" / "…portal respondió: Class full"). mikampus toca matrícula real de terceros: cuando el auto-enroll haga algo que un usuario no esperaba — y va a pasar — la diferencia entre "confío" y "desinstalo" es poder mostrarle exactamente qué se hizo y qué contestó el portal. Es una tabla (`action_log`) que se escribe en cada acción viva; barata, y es la feature de confianza más importante de la plataforma.
4. **Tus datos** — lista *qué* guardamos (con fecha de último sync por tipo, de `sync_log`), **si hay una credencial cifrada guardada ahora mismo, por qué y hasta cuándo** ("guardada hasta que cierre la inscripción de Sept-2026" — la vida de §5 regla 3, siempre visible), y el botón **"Borrar todos mis datos"**: elimina sus filas, su credencial, cierra sesión y lo devuelve a la landing. Solo borra lo nuestro — su cuenta de micampus no se toca, y el texto lo dice explícito, igual que la ventana de backups de §3 ("salen de las copias de seguridad en ≤3 días"). Confirmación con fricción: es irreversible.

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
2. **Armado** — carrito listo, falta decidir el disparo: programar hora (countdown de `Countdown.tsx` central) o watcher. Con la hora por escuela (Fase 0.3): "Armado" propone tu hora en un click en vez de pedirte escribirla. Programado el disparo, esta vista también dice qué va a pasar: "a las 5:52 preparo tu sesión; a las 6:00:00 someto" (§5.6).
3. **En vivo** — `LiveOpBanner` + `ActivityFeed` toman la pantalla, paso a paso (honestidad de estado, PLAN.md §1.6).
4. **Resultado** — qué entró y qué no, materia por materia, con siguiente acción para las que fallaron (activar watcher sin re-consentir: la credencial sigue viva por la regla 3 de §5).

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

El riesgo número uno sigue siendo la **relación con el portal**: aunque ya casi no custodiamos credenciales (§5 lo reduce a una ventana cifrada por término), el server concentra el scraping de N estudiantes — y tu cuenta de servicio absorbe la parte compartida. Eso la vuelve el **single point of failure atribuible**: si el portal la bloquea, muere el dato compartido de todos *y tu propia matrícula*, el mismo día. Mitigación: rate-limits conservadores, no scrapear nada que ningún usuario pidió, cupos solo con watchers activos, jitter en todo lo programado, y la prueba de IP de Fase 0 (incluido el patrón multi-login) antes de todo. El dos es **PeopleSoft cambia** (un selector roto rompe a todos a la vez, y MFA rompería el modo desatendido): hace falta que el server te avise *a vos* cuando algo falla repetido — y ese canal de operador **no puede ser solo Web Push** (a las 6am tu teléfono también está en No Molestar): un fallback tonto — Telegram/ntfy/email — para "3 fallos seguidos" cuesta una tarde y es la diferencia entre enterarte a las 6:01 o a las 9. El tres es **el día-D**: N pre-warms y disparos sobre el pool de contexts se prueban con antelación (CPU del pico incluida, §1), con detección de crash del Chromium compartido y relanzamiento. Y el cuatro es **el crédito de DigitalOcean**: es finito y no debe convertirse en una factura por omisión; monitorear saldo/fecha, sin upgrade automático, y sostener el modo local como salida real.

## 14. Orden propuesto

Cada fase en su rama, como siempre:

0. **Fase 0 — validar supuestos** (§0.5): Droplet de DigitalOcean + `loginToPeopleSoft` desde ahí (incluido el patrón multi-login con jitter); recon del **Change Term** y confirmación del límite de 50; hora de inscripción por escuela documentada. Una tarde-un día; puede invalidar decisiones de abajo, por eso va primero.
1. **Walking skeleton hosted** — la app actual, single-user, corriendo en la VM con Docker + Caddy + basic auth provisional + Litestream (retención ~72h, bucket cifrado) + `TZ` fijado. Vos como único usuario real una semana desde el teléfono. Valida RAM, IP, PWA y operación antes del big bang multi-usuario.
2. **Multi-usuario de base** — `user_id` en tablas personales sobre SQLite **+ migración de los datos existentes como usuario 1 + adaptación de los scripts de test**, pénsum re-modelado por carrera con merge conservador (§3.1), pool de contexts por usuario + cuenta de servicio (§1), semántica de retry de `withPage` (§0), auth + cookie SameSite + CSRF, credenciales RAM + almacén cifrado con vida por término (§5), timers persistidos, `action_log`.
3. **Login + landing + Ajustes** — las tres pantallas del ciclo de cuenta (§5, §6, §8) incluidos los estados de la costura sesión/credencial (§5.1), allowlist de invitación, Historial (audit log), lazy loading con vida útil + refresh global (§3.2) y la experiencia de primer sync.
4. **Watcher + push + disparo** — Web Push (VAPID, con instalación de PWA como paso del onboarding), watcher sobre cupos compartidos con presupuesto de scraping + appointment-aware + cola de fairness (§5.5), **pre-warming del disparo (§5.6)**, detección de grupos nuevos, alerta al operador con fallback (§13).
5. **Consolidación de navegación** — Holds→Dashboard, Planner+Builder→Planear, adiós /buscar, sidebar con iconos (§7.2, §9, §10, §12).
6. **Rework visual** — WeeklyGrid, emojis→iconos, Inscripción con estado maestro y buscador consciente del ciclo (§7.1, §7.3, §11).
7. **Lanzamiento** — DNS definitivo, prueba de carga del día-D (pre-warms incluidos), **onboarding por invitación días antes del día-D** (el primer sync de cada compañero ocurre la semana anterior, nunca a las 5:50am), invitar a los primeros compañeros.

## 15. Decisiones

**Cerrada para Fase 4:** fairness del auto-enroll (§5.5) es FIFO por orden de
activación del watcher, con posición visible y persistida.

**Cerrada en L1/L3:** la promesa de borrado con backups (§3, §8) es la
recomendada — "tus datos salen de los backups en ≤3 días": Litestream con
retención de 72h y backups locales con `MIKAMPUS_BACKUP_KEEP=3`, y el texto de
Ajustes lo dice tal cual.

**Cerrada en L5:** Planner+Builder unificados en `/planear` con las tabs
Materias/Horario (§10), tal como proponía el documento.

**Sin pendientes.** Las fases L0–L7 están implementadas e integradas en `dev`;
lo que queda del lanzamiento son las acciones del operador que `docs/launch.md`
reserva a ejecución consciente: gate en el Droplet, ensayo del día-D e
invitaciones.
