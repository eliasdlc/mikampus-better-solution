# mikampus — Plan de migración a open source local

> **Documento vivo.** Es la fuente de verdad del giro de mikampus de servicio hosted
> multiusuario a **programa open source que cada estudiante corre en hardware propio**. Está
> pensado para que cualquier chat futuro (o persona) retome el trabajo sin contexto
> previo: acá está la meta, el porqué, las decisiones cerradas, las fases, los pasos y
> el estado real. **Al cerrar cada fase, actualiza el bloque "Estado actual".**

---

## Estado actual

- **Fecha de última actualización:** 2026-07-22
- **Rama de trabajo:** `feat/single-user-secure`, creada desde `dev`. La rama histórica
  `feat/open-source-ready` queda preservada tras el merge de Fase 0.
- **Fase en curso:** siguiente Fase 4 — Onboarding, notificaciones y ciclo de vida de datos.
- **Precondición de rama:** resuelta. El trabajo pendiente de sincronización de horario se
  preservó en commits propios y se integró mediante PR, sin descartar cambios.
- **Avance de Fase 0:** LICENSE MIT, notices, política de seguridad, disclaimers visibles,
  contrato de egress, threat model y política de fixtures ya están versionados. Existen
  gates `typecheck`, `lint`, `audit:public` y `audit:history`; el sanitizer cubre atributos
  en cualquier orden, identificadores y nombres. La documentación hosted quedó marcada como
  histórica/no ejecutable.
- **Auditoría histórica:** se reescribió la historia alcanzable para sustituir el contenido
  de los dos fixtures que introdujo `489a2a4` por versiones sanitizadas. Tras retirar las
  referencias de respaldo y recolectar objetos antiguos, `npm run audit:history` pasa sobre
  todas las ramas publicables. Los clones existentes deben re-clonarse o resincronizarse.
- **Cierre de Fase 0:** se retiraron los dos fixtures sin cobertura; los 18 restantes tienen
  propósito registrado y límite de tamaño en `fixtures/manifest.json`. `npm test`,
  `npm run typecheck`, `npm run lint`, `npm run audit:public` y `npm run audit:history`
  pasan. P2 permanece como blocker explícito del primer package o release.
- **Cierre de Fase 1:** `HEAD` conserva un único operador, una sola sesión/cola de
  Playwright y bind fijo a loopback. El runtime hosted/multiusuario, sus deploys y sus
  validadores se retiraron sin reescribir historia ni borrar ramas. Desktop usa el
  almacén seguro del OS; Home Server conserva el vault cifrado separado. Las mutaciones
  exigen Origin local, sesión, cookie HttpOnly/SameSite y CSRF; watcher y schedule exigen
  consentimiento, propósito y vencimiento, y un rechazo de credenciales detiene el loop.
- **Cierre de Fase 2:** el agente durable tiene lock exclusivo, ownership por PID y
  healthcheck autenticado; `npm run mikampus --` controla start/stop/status/open/doctor,
  servicio, backup/restore y erase-data confirmado. Watchers/schedules persisten estados,
  gaps, backoff y submits inciertos; al volver se consulta una vez y nunca se reenvía un
  submit incierto. `deploy/home-server/` mantiene datos en volumen, reinicia el servicio y
  restringe el acceso remoto al túnel SSH de loopback. La fase queda validada en source;
  los smokes de artefactos y matriz nativa corresponden al spike de Fase 3.
- **Cierre de Fase 3:** `build:production` compila SPA y backend ESM sin type stripping
  y produce un payload limpio con dependencias de producción. El launcher fija app-data
  antes de SQLite/Playwright; el artifact smoke verificó SPA, migración SQLite fuera del
  CWD, notices y un fixture Chromium descargado en primer uso. El ADR documenta SEA/Bun,
  tamaño, browser y matriz: RC1 soporta Linux x64 (Ubuntu 24.04/Debian 12); los demás
  targets quedan explícitamente fuera hasta tener smoke nativo y resolver P3. `npm pack
  --dry-run` contiene sólo runtime, SPA y avisos, no fixtures/recon/tests/hosted.

| Fase | Nombre | Estado |
|------|--------|--------|
| 0 | Contrato local, privacidad y desbloqueo open source | ✅ Hecho |
| 1 | Single-user seguro (auth local, credenciales, retiro hosted) | ✅ Hecho |
| 2 | Runtime durable (Desktop + Home Server, lifecycle, watcher) | ✅ Hecho |
| 3 | Spike de empaquetado y build de producción | ✅ Hecho |
| 4 | Onboarding, notificaciones y ciclo de vida de datos | ⬜ Pendiente |
| 5 | Distribución (instaladores/binarios + npm) | ⬜ Pendiente |
| 6 | CI de releases, documentación y landing | ⬜ Pendiente |

Leyenda: ⬜ pendiente · 🟨 en curso · ✅ hecho.

---

## La meta

mikampus deja de ser una app multiusuario operada por un tercero y pasa a ser
**open source de ejecución y datos locales**:

- Cada estudiante corre una instancia **single-user**, con su propia cuenta y sus propias
  credenciales, en hardware que controla.
- **Credenciales, ejecución y datos académicos viven en hardware del usuario.** No hay
  base de datos central, cuenta de servicio compartida, pool multiusuario ni telemetría.
- PUCMM es el único servicio externo requerido durante el uso normal. GitHub, npm,
  Vercel y el CDN de Playwright son infraestructura de distribución/instalación y nunca
  reciben credenciales ni datos académicos.
- La interfaz sigue siendo web y se abre en el navegador; el agente que hace el trabajo
  vive separado del navegador y puede seguir activo aunque se cierre la pestaña.
- Hay dos modos soportados: **Local Desktop** y **Home Server**.

Frase corta: *"tus datos, tu cuenta, tu hardware."*

### Los dos modos soportados

| | Local Desktop Mode | Home Server Mode |
|---|---|---|
| Dónde corre | PC Windows/macOS/Linux del estudiante | Raspberry Pi, NAS, mini-PC, spare PC o servidor doméstico del estudiante |
| Lifecycle | Agente del usuario iniciado por el OS al hacer login | Servicio/container single-user iniciado por el OS y reiniciado tras fallos/reboots |
| UI | `localhost`, navegador por defecto | `localhost` vía túnel SSH por defecto; LAN solo con auth + HTTPS explícitos |
| Watcher | Solo mientras el equipo esté encendido, despierto, online y el agente corra | 24/7 solo si ese equipo permanece encendido y online |
| Notificación base | Notificación nativa del OS + feed en la UI | Feed local; adaptadores externos o self-hosted solo por opt-in explícito |
| Datos | Carpeta de aplicación del usuario | Volumen/directorio persistente del servidor doméstico |

### Contrato operativo del watcher y los trabajos programados

- **Cerrar la pestaña no detiene mikampus.** El agente de fondo es independiente del
  navegador.
- **Cerrar o detener el agente sí detiene el trabajo.** La UI y `mikampus status` deben
  decirlo sin ambigüedad.
- **Dormir, hibernar o apagar el equipo pausa todo.** Al volver, se registra el intervalo
  no vigilado y se hace una sola consulta fresca; no se inventan ni reproducen ticks.
- **Un equipo apagado no puede vigilar ni inscribir.** Los wake timers son una ayuda
  best-effort para sleep/hibernate compatible, nunca una garantía ni una forma de prender
  hardware totalmente apagado.
- **No se puede reconstruir un cupo que abrió y cerró durante la pausa.** `lastCheckedAt`
  y el gap de monitoreo son parte del estado del producto, no un detalle técnico.
- Para cinco horas de continuidad en Desktop: equipo despierto, conectado a corriente si
  aplica, con internet y agente activo. Para una semana real: Home Server en hardware
  siempre encendido o aceptar los gaps de Desktop.
- `npx mikampus` es una ejecución temporal en foreground: cerrar la terminal la detiene.
  El servicio durable se obtiene con el instalador standalone o con una instalación global
  seguida de `mikampus install-service`.

---

## Por qué este giro — el problema legal que resuelve

Esto salió de un análisis de legalidad (chat `39d6f6b9`, 2026-07-21). No es asesoría
legal, pero mapea el riesgo real. La jurisdicción que importa es **República Dominicana**
(PUCMM), no leyes de EE.UU. — ignorar CFAA / *hiQ v. LinkedIn*, es una trampa común.

### Los tres "buckets" de riesgo

1. **Herramienta de uso personal — tu cuenta, tus credenciales, tu máquina.** Automatizas
   acciones que ya estás autorizado a hacer, en tu propia cuenta. Riesgo mínimo: más
   cercano a una macro de navegador que a "hackear". El riesgo residual es una posible
   violación de los Términos de Uso que **tú** asumes personalmente.
2. **Distribuir la herramienta para que cada usuario la corra local con sus propias
   credenciales** (nada centralizado). Más exposición a ToS, pero **no eres custodio de
   las credenciales ni de los datos de nadie**.
3. **Servicio hosted que inicia sesión como otros estudiantes y guarda sus credenciales
   y datos.** Acá convergen la ley penal de acceso no autorizado, la de protección de
   datos, y la responsabilidad real. **Es la forma que hay que abandonar.**

### Dónde estaba mikampus y a dónde va

El código **hoy** está en el bucket 3: `MIKAMPUS_MODE=hosted`, `MIKAMPUS_ALLOWLIST=elias,ana`,
un pool multiusuario en `session.js`, un `credentialVault.js` que guarda contraseñas de
PeopleSoft de **otros** estudiantes (AES-256-GCM, pero con la clave en el mismo servidor),
y un watcher con cuenta de servicio. Los cuatro focos de exposición identificados:

- **Ley 53-07 (Crímenes de Alta Tecnología):** un servidor que inicia sesión en la cuenta
  de `ana` con su contraseña guardada = acceso a una cuenta que no es tuya vía automatización.
  El consentimiento de `ana` no autoriza a un tercero a manejar el sistema de la universidad.
- **Ley 172-13 (Protección de Datos):** acumular notas, horarios, datos financieros y
  contraseñas de **otras** personas te convierte en procesador de datos con obligaciones
  que un proyecto estudiantil no cumple. Para **tus propios** datos, es un no-problema.
- **Términos de Uso / Uso Aceptable:** es la consecuencia **más probable** en la práctica —
  no es un crimen, es asunto contractual/disciplinario: suspensión de cuenta, audiencia
  disciplinaria. Para un estudiante, la sanción académica puede doler más que la legal.
- **Trazabilidad ("con que nadie se entere"): era falsa.** El diseño hosted era casi
  máximamente rastreable: **una sola IP de datacenter** (el Droplet) autenticando muchas
  cuentas — patrón trivial de detectar en los logs de PUCMM; timing robótico del watcher;
  fingerprint headless; y `DOMAIN=mikampus.decruce.dev` (`decruce` = tú) atado a ti por
  WHOIS público. La evidencia se escribía **en los servidores de PUCMM**, que tú ni ves ni
  puedes borrar, apuntando a **cada cuenta que usó el servicio**, incluidos los amigos que
  te confiaron su contraseña. Esa es la asimetría: el riesgo no era solo tuyo.

### La conclusión que ordena todo el plan

**Colapsar a single-user en hardware del usuario elimina el modelo operativo del bucket 3.**
Cada ejecución concreta pasa a ser una herramienta personal del operador (bucket 1), aunque
publicar y distribuir el software conserva la exposición propia del bucket 2. Se elimina la
custodia central de credenciales/datos ajenos y la correlación de muchas cuentas desde una
instancia, pero no desaparecen el riesgo de ToS, marca, copyright ni la responsabilidad por
lo que el proyecto distribuya.

Por eso la privacidad/licencia de **Fase 0** y el colapso single-user de **Fase 1** van
primero: no son papeleo, son la razón de ser del giro.

Camino limpio adicional (no-código, opcional pero recomendado): **avisarle a PUCMM
IT/registraduría** qué construiste y preguntar si lo sancionan o lo quieren. Un "no" te
deja donde ya estabas; un "sí" elimina el problema de autorización que ninguna encriptación
resuelve.

---

## Decisiones cerradas (registro)

Confirmadas por el usuario. Cambiarlas requiere una decisión explícita nueva.

| # | Decisión | Detalle | Fecha |
|---|----------|---------|-------|
| D1 | **NO Electron** | Se descartó por pesado. Un launcher/control CLI habla con un agente liviano y abre la UI en el navegador; el agente no depende de que la pestaña siga abierta. | 2026-07-21 |
| D2 | **Distribución: ambas formas** | (a) artefacto/installer standalone por OS para estudiantes; (b) npm para devs con Node ≥24. Packager, tamaño y formatos exactos se cierran con evidencia en el spike. | 2026-07-21 |
| D3 | **Browser administrado en primer arranque** | No se bundlea Chromium por defecto. Se prueba headless shell, browser compatible ya instalado y descarga Playwright; tamaño/estrategia final salen del spike. | 2026-07-21 |
| D4 | **Landing en Vercel** | Sitio estático nuevo (`landing/`) que consume un manifest generado por release, sugiere OS y siempre muestra todos los artefactos/checksums + npm para devs. | 2026-07-21 |
| D5 | **Licencia MIT** | Incluye la cláusula estándar de no-garantía, sin presentarla como garantía de legalidad o protección absoluta. | 2026-07-21 |
| D6 | **Sin servicio hosted operado por el proyecto** | Se retira DigitalOcean/Caddy/Litestream y todo modo multiusuario. Sí se permite un `deploy/home-server/` single-user para hardware controlado por el estudiante. | 2026-07-21 |
| D7 | **Dos runtimes soportados** | Local Desktop para uso normal y Home Server para continuidad 24/7 en hardware siempre encendido del usuario. | 2026-07-21 |
| D8 | **Watcher con contrato honesto** | Desktop solo vigila con equipo encendido, despierto, online y agente activo; Home Server solo es 24/7 si el servidor realmente lo es. | 2026-07-21 |
| D9 | **Agente separado del navegador** | Cerrar la pestaña no detiene el backend; el OS administra el agente/servicio y el launcher abre o controla la instancia existente. | 2026-07-21 |
| D10 | **Cloud de distribución, no de datos** | GitHub/npm/Vercel/CDN pueden distribuir artefactos; PUCMM es el único servicio externo requerido en runtime base. Sin telemetría. | 2026-07-21 |
| D11 | **Notificaciones locales por defecto** | Desktop usa notificaciones nativas. Home Server ofrece feed local; cualquier push/webhook/VPN/ntfy externo es opt-in y se declara como tráfico externo. | 2026-07-21 |
| D12 | **Credenciales en almacén del OS** | Desktop usa Credential Manager/Keychain/Secret Service; Home Server usa vault cifrado con secret separado. `account.json` en claro se elimina. | 2026-07-21 |

### Decisiones resueltas y pendientes

- **P1 — Resuelta (2026-07-22):** se retiró el código hosted/multiusuario de `HEAD`,
  preservando la historia y las ramas existentes. La documentación de despliegue hosted se
  retiró junto con el runtime.
- **P2 — El nombre "mikampus".** Es casi idéntico a "MiCampus", el nombre del portal de
  PUCMM → posible cercanía de marca. Mínimo: disclaimer "no afiliado ni respaldado por
  PUCMM" bien visible. A evaluar: renombrar. El repo ya es público; decidir antes de
  publicar paquetes/instaladores y promocionar la landing.
- **P3 — Firma y notarización.** Definir después del spike si el primer release acepta la
  fricción de Gatekeeper/SmartScreen o si firma de macOS/Windows es requisito. Mientras
  siga pendiente, "descargar y doble clic" no se considera demostrado.
- **P4 — Matriz exacta de CPU/OS.** El spike debe cerrar si el primer release cubre solo
  Windows x64 + macOS ARM64/x64 + Linux x64, o también ARM64 de Windows/Linux.

### Límites de lo que resuelven la licencia y el retiro hosted

- MIT permite modificar, redistribuir y volver a hostear forks; no puede imponer uso
  personal-only. El proyecto deja de operar y soportar el modelo hosted, pero no puede
  prometer que terceros no lo reconstruyan.
- Sacar hosted de `HEAD` no lo borra de la historia pública ni de clones existentes. Si
  aparece un secreto o PII real, el tratamiento es rotación + auditoría y, solo con
  autorización explícita, posible reescritura de historia.
- La cláusula de no-garantía de MIT y los disclaimers informan límites; no garantizan
  legalidad ni eliminan ToS, marca, copyright o responsabilidad.
- Los fixtures derivados de PeopleSoft requieren revisión de PII, secretos y contenido de
  terceros; la solución preferida es reemplazar páginas completas por fixtures mínimos y
  sintéticos que conserven solo el DOM necesario para probar parsers.

---

## Arquitectura: hoy vs objetivo

**Hoy** (`src/server.js`): un Express que sirve la SPA de `web/` y expone `/api/*`. Corre
en dos modos con el mismo código vía `MIKAMPUS_MODE` (`local` por defecto | `hosted`). Los
scrapers de PeopleSoft viven en `src/peoplesoft/` sobre el pool Playwright de
`src/session.js`. Datos en SQLite (`src/db.js`, `node:sqlite`). Todas las rutas de
escritura ya son configurables por env (`MIKAMPUS_DB`, `MIKAMPUS_ACCOUNT`,
`MIKAMPUS_CRED_DB`, `MIKAMPUS_BACKUP_DIR`).

**Objetivo:** un core single-user compartido por dos hosts de ejecución:

```text
                    ┌─────────────────────────────┐
                    │ core single-user mikampus   │
                    │ API + SQLite + Playwright   │
                    │ scheduler + migrations      │
                    └──────────────┬──────────────┘
                                   │
                  ┌────────────────┴────────────────┐
                  │                                 │
       ┌──────────▼──────────┐           ┌──────────▼──────────┐
       │ Local Desktop Agent │           │ Home Server Service │
       │ OS service + native │           │ systemd/container   │
       │ notify + localhost  │           │ single-user + auth  │
       └──────────┬──────────┘           └──────────┬──────────┘
                  │                                 │
       navegador en localhost          túnel SSH o LAN HTTPS explícito
```

- **Core:** sin `MIKAMPUS_MODE`, allowlist, pool multiusuario, cuenta de servicio ni
  identidad variable. Un solo operador y una sola cola de PeopleSoft.
- **Agente Desktop:** proceso independiente del navegador, administrado por Task
  Scheduler/LaunchAgent/systemd-user, con singleton y notificaciones nativas.
- **Servicio Home Server:** el mismo core, como servicio o container single-user; bind
  loopback por defecto, acceso remoto por túnel SSH o LAN solo detrás de auth + HTTPS.
- **Control CLI:** `start`, `stop`, `status`, `open`, `doctor`, `install-service`,
  `uninstall-service`, `backup`, `restore` y `erase-data`.
- **Web UI:** SPA compilada y servida por el core; SSE es feed en vivo, no el transporte
  primario de notificaciones fuera de la pestaña.
- **Adaptadores:** credential store y notification transport cambian por plataforma sin
  cambiar scheduler/scrapers.
- **Distribución:** instaladores/artefactos standalone para estudiantes y paquete npm para
  desarrolladores; landing estática separada.

**Restricción técnica que manda:** el backend usa features de **Node ≥24** — `node:sqlite`
sin flag (`db.js`, `credentialVault.js`) y **imports de `.ts` desde `.js`** vía type
stripping nativo (ej. `goals.js` → `./shared/gpa.ts`, y ~10 más). El type stripping es la
parte frágil para distribuir, pero no la única: SEA necesita un entry bundleado y un
mecanismo explícito para SPA/assets; Playwright tiene resolución dinámica de paquete y de
browser. La Fase 3 prueba el artefacto real antes de decidir packager.

### Frontera de red y privacidad

| Destino | Cuándo | Estado por defecto | Datos permitidos |
|---|---|---|---|
| PUCMM | Login, sync, watcher, acciones | Requerido | Credencial y tráfico académico necesarios para la operación |
| CDN de Playwright | Primer arranque/upgrade del browser | Requerido si no hay browser compatible | Versión/plataforma; nunca credencial PUCMM |
| GitHub Releases/npm/Vercel | Descarga, instalación, update-check manual | Distribución | Versión, plataforma e IP normal de descarga; nunca datos académicos |
| Push/webhook/ntfy externo | Solo si el usuario lo configura | Apagado | Payload mínimo y documentado; nunca credenciales |
| Telemetría/analytics | Nunca | No existe | Ninguno |

El runtime tendrá una prueba de egress que falle si aparece un destino no declarado. Los
update-checks son manuales o claramente opt-in y toda descarga se verifica por integridad.

---

## Las fases

Todo vive en `feat/open-source-ready`, con commits atómicos. Una fase no cierra por tener
código escrito: cierra cuando pasan sus pruebas, su artifact smoke cuando corresponda, y se
actualiza "Estado actual".

### Fase 0 — Contrato local, privacidad y desbloqueo open source

**Meta:** hacer seguro seguir trabajando en un repositorio que ya es público y fijar las
promesas que todas las fases posteriores deben respetar.

1. Agregar `LICENSE` MIT, `THIRD_PARTY_NOTICES`, política de seguridad y disclaimer visible:
   uso personal, cuenta propia, no afiliado a PUCMM, sin garantía y riesgo de ToS.
2. Decidir P1/P2 o dejarlas como blockers explícitos del primer package/release; retirar de
   la narrativa cualquier afirmación de que MIT garantiza legalidad o impide hosting.
3. Auditar HEAD e historia por secretos/PII. Corregir el sanitizer para no depender del
   orden de atributos HTML y agregar un test que falle con `ICSID`, `ICStateNum`, EMPLID,
   request IDs, nombres de estudiante u otros tokens no anonimizados.
4. Reemplazar fixtures completos por DOM mínimo/sintético cuando sea posible; revisar
   copyright/licencias de HTML, iconos, fuentes, Chromium y dependencias redistribuidas.
5. Definir y versionar el contrato de egress anterior; no telemetry y adaptadores externos
   apagados por defecto.
6. Añadir scripts reales `typecheck` y `lint`; arreglar la falla TypeScript baseline actual
   en `web/src/lib/push.ts` antes de llamar verde al repo.
7. Documentar el threat model: proceso local malicioso, página web atacando localhost,
   otro equipo de la LAN, robo de backups, dependencia comprometida y servidor doméstico
   expuesto por error.

**Aceptación:** LICENSE y avisos presentes; cero secretos/PII detectados en lo publicable;
fixtures permitidos y mínimos; egress/threat model documentados; test, typecheck y lint
verdes; ningún package o release se publica todavía.

### Fase 1 — Single-user seguro

**Meta:** eliminar el modelo hosted multiusuario y dejar una identidad/credencial propia
con fronteras seguras tanto en Desktop como Home Server.

1. Retirar `MIKAMPUS_MODE=hosted`, `MIKAMPUS_ALLOWLIST`, pool por usuario, FIFO entre
   estudiantes, cuenta de servicio, `DOMAIN`, `MIKAMPUS_EXPECTED_IPV4`, DigitalOcean,
   Caddy público, Litestream cloud, `.env.hosted.example` y validadores hosted.
2. Conservar una sola cola/sesión/identidad: el watcher consulta con la misma cuenta del
   operador y nunca con una credencial compartida.
3. Desktop: bind exclusivo a loopback, token aleatorio emitido por launcher, cookie
   HttpOnly/SameSite para localhost, CSRF y validación estricta de `Origin`/`Host`;
   retirar `HOST=0.0.0.0`.
4. Home Server: bind loopback por defecto + túnel SSH; permitir LAN solo con pairing/admin
   secret, sesiones, CSRF y HTTPS mediante reverse proxy explícito. Nunca instruir port
   forwarding directo a internet.
5. Reemplazar `account.json` plaintext: RAM para uso interactivo; Credential Manager,
   Keychain o Secret Service para Desktop; vault cifrado + secret file/Docker secret
   separado para Home Server. Explicar que cifra backups, no salva un host comprometido.
6. Toda función desatendida — watcher notify-only incluido— pide consentimiento, propósito
   y vencimiento porque toda consulta puede necesitar re-login.
7. Rechazo de contraseña, MFA, CAPTCHA o keychain bloqueado detiene automatización y pide
   intervención; nunca martilla el portal con reintentos de login.
8. Implementar borrado completo del secreto y revocación de sesiones al cambiar cuenta,
   vencer consentimiento, borrar datos o desinstalar.
9. Mantener intervalos conservadores, una materia por tick, jitter y backoff exponencial;
   el watcher solo corre cuando el usuario lo activó y debe apagarse fuera del período útil.
10. Retirar hosted de `HEAD` según P1, preservando historia/ramas salvo que una auditoría de
   secretos exija una acción separada y autorizada.

**Aceptación:** solo existe el operador; no hay endpoint mutante utilizable desde una web
ajena o LAN no autorizada; no hay contraseña en texto claro; un credential rejection corta
el loop; el producto enviado no contiene deploy hosted ni datos de terceros.

### Fase 2 — Runtime durable: Desktop + Home Server

**Meta:** separar navegador de proceso y hacer explícito, durable y comprobable el ciclo de
vida de watchers, schedules y acciones.

1. Separar core/server del host de proceso: abrir/cerrar el navegador no crea ni destruye
   el agente.
2. Crear CLI idempotente: `start`, `stop`, `status`, `open`, `doctor`, `install-service`,
   `uninstall-service`, `backup`, `restore`, `erase-data`.
3. Integrar Task Scheduler (Windows), LaunchAgent/LoginItem (macOS) y systemd user service
   (Linux), con restart tras crash y start al login sin abrir navegador automáticamente.
4. Agregar singleton lock con PID/ownership + health autenticado: segunda ejecución abre la
   existente; un port conflict ajeno falla de forma segura, nunca elige otro puerto a ciegas.
5. Convertir watcher compartido/FIFO a watcher single-user. Persistir configuración,
   `lastCheckedAt`, último estado, próxima consulta, fallos consecutivos y razón de pausa.
6. Detectar gap de wall clock, sleep/resume, pérdida/recuperación de red y reboot. Al volver:
   registrar gap, invalidar sesión si aplica y ejecutar una consulta fresca, no todos los
   ticks perdidos.
7. Exponer estados `running`, `paused`, `offline`, `credentials-required`, `backing-off`,
   `stopped` y `monitoring-gap` en API/UI/CLI.
8. Rehacer acciones durables como state machine:
   `pending → preparing → submitting → succeeded | failed | uncertain`. Nunca borrar el
   schedule antes de conocer el resultado; reconciliar `uncertain` contra PUCMM al arrancar.
9. Un schedule vencido mientras el agente estaba abajo queda `missed` con explicación; solo
   una tolerancia corta y explícita permite late-fire. Wake timers son best-effort opt-in.
10. Home Server: agregar `deploy/home-server/` single-user con systemd y/o Compose, volumen
    persistente, healthcheck, restart policy, backup/restore y guías x64/ARM64.
11. Crear interfaz de notifications: Desktop nativo; Home Server feed local; transportes
    self-hosted/externos se conectan después sin contaminar scheduler.

**Aceptación:** cerrar browser no detiene watcher; detener agente sí; segunda instancia no
duplica trabajo; sleep/reboot dejan gap honesto; crash en submit produce `uncertain` y se
reconcilia; Home Server sobrevive reboot y sigue siendo single-user.

### Fase 3 — Spike de empaquetado y build de producción

**Meta:** demostrar el artefacto real antes de prometer formato, tamaño o plataformas.

1. Crear build de producción que compile shared TS para backend sin type stripping, compile
   la SPA y produzca un entry del server bundleable. Mantener source TS para Vite/tests sin
   sobrescribir archivos del repo.
2. Comparar Node SEA y alternativas en un ADR. Bun solo gana si demuestra compatibilidad
   real con `node:sqlite`, Playwright, ESM, assets y proceso/servicio en todos los targets.
3. Probar carga de dependencias Playwright, static assets, SPA, iconos, manifest, service
   worker, LICENSE/notices y módulos dinámicos dentro del artifact.
4. Introducir un resolver de paths único para repo, npm y standalone; datos/logs/backups/
   browser siempre van a app-data, nunca junto al ejecutable ni al CWD.
   Roots Desktop: `%APPDATA%\mikampus` (Windows), `~/Library/Application Support/mikampus`
   (macOS), `${XDG_DATA_HOME:-~/.local/share}/mikampus` (Linux); Home Server usa el volumen
   persistente configurado.
5. El launcher debe fijar paths/secrets antes de importar módulos que abren SQLite; usar
   import dinámico o proceso hijo para evitar env configurado demasiado tarde.
6. Chromium first-run: probar headless-only shell, browser instalado compatible y browser
   administrado por Playwright; medir tamaño y fiabilidad antes de cerrar D3.
7. Probar descarga con progreso, cancelación, retry, proxy, CA custom, poco disco,
   interrupción y upgrade de Playwright/browser; garbage-collect solo versiones seguras.
8. Cerrar P4 con matriz explícita de OS/CPU y mínimos soportados. Linux significa distros
   verificadas, no cualquier distro por defecto.
9. Preparar npm con `engines: node >=24`, `bin`, `files` allowlist, `prepack` y artifact
   smoke. `npx` es foreground; instalación global/standalone es la vía durable.

**Aceptación:** un artefacto limpio sirve SPA, crea/migra SQLite en app-data, instala/lanza
browser y completa un smoke con fixtures en cada target de la matriz; ADR y tamaños reales
documentados; `npm pack --dry-run` no incluye hosted, fixtures, recon ni tests y sí incluye
todo lo necesario para correr.

### Fase 4 — Onboarding, notificaciones y ciclo de vida de datos

**Meta:** convertir el runtime probado en una experiencia segura y entendible de primer uso,
operación diaria, actualización y salida.

1. Onboarding elige Desktop u Home Server, explica sus garantías y verifica prerequisitos.
   En Desktop, `Login.tsx` deja de saltarse login por estar en modo local.
2. Instalar/verificar Chromium con progreso en una UI servida antes de tocar PUCMM; luego
   pedir credenciales, verificarlas y guardar solo según consentimiento elegido.
3. Mostrar permanentemente estado del agente, watcher, último check, gap, backoff, próxima
   acción, credential expiry y si el equipo debe permanecer despierto.
4. Desktop: notificaciones nativas Win/macOS/Linux desde el agente, con dedupe y deep-link.
   SSE queda como feed; se prueba con browser cerrado.
5. Home Server: feed local base y adaptadores opcionales (self-hosted ntfy, webhook, Web
   Push u otro). Cada uno muestra destino, payload, dependencia externa y botón de prueba.
6. Agregar schema version y migraciones SQLite numeradas/transaccionales; backup pre-upgrade,
   recuperación de migración fallida y compatibilidad declarada de rollback.
7. Backups por `lastSuccessfulBackup`, con catch-up al startup, retención configurable,
   `VACUUM INTO`, verificación de restore y export a carpeta/disco elegido por el usuario.
8. Explicar que backups en el mismo disco no protegen de pérdida física; no habilitar cloud
   backup silencioso.
9. `erase-data` y uninstall eliminan DB/WAL/SHM, vault, keychain, backups, logs, diagnostics,
   browser/service-worker state propio y subscriptions; ofrecen preview + confirmación.
10. Diagnostics viven en app-data, redacted por defecto, sin screenshots de PII fuera de esa
    carpeta y solo se exportan por acción explícita.
11. Agregar update-check manual/opt-in, descarga verificada y flujo de update que detiene
    agente, respalda, migra, valida health y conserva recovery path.

**Aceptación:** primer uso completo sin terminal; browser cerrado recibe notificación nativa;
Home Server declara cualquier salida externa; upgrade/backup/restore/erase pasan pruebas;
ninguna credencial o captura sensible queda fuera del almacén previsto.

### Fase 5 — Distribución: instaladores/binarios + npm

**Meta:** entregar las dos puertas de entrada con lifecycle y desinstalación reales.

1. Generar artefactos por OS/CPU de la matriz, con nombres/versiones inequívocos. En macOS,
   preferir `.app`/DMG; en Windows, installer que administre servicio/shortcut/uninstall; en
   Linux, formato(s) definidos por la matriz más tarball avanzado si conviene.
2. El installer standalone instala core, agente y launcher; el acceso "mikampus" abre la
   instancia existente. No dejar una consola accidental como única señal de que corre.
3. Publicar paquete npm estricto. `npx mikampus` corre foreground; `npm install -g mikampus`
   + `mikampus install-service` habilita el agente durable con advertencias claras.
4. Resolver P3: firmar/notarizar o documentar exactamente Gatekeeper/SmartScreen y aceptar
   que "doble clic y ya" queda limitado. No presentar warnings como detalle invisible.
5. Incluir checksums SHA-256, provenance/attestation, SBOM o inventario de dependencias,
   THIRD_PARTY_NOTICES y pasos verificables de instalación.
6. Probar install → first-run → stop/start → upgrade → uninstall en máquinas limpias de
   cada target; confirmar que uninstall pregunta si preservar o borrar datos.
7. Definir soporte/updates de scrapers: versión incompatible puede bloquear acciones
   mutantes sin borrar datos locales hasta que haya release corregido.

**Aceptación:** cada artifact instala, corre, se actualiza y desinstala según su OS; npm
tarball corre desde lo publicado; servicios sobreviven reboot; checksums/notices presentes;
ningún target se declara soportado solo porque "compiló".

### Fase 6 — CI de releases, documentación y landing

**Meta:** hacer releases reproducibles, verificadas y fáciles de entender sin convertir la
distribución en un backend de datos.

1. GitHub Actions por tag compila la matriz en runners nativos, corre unit/typecheck/lint,
   artifact smoke, install smoke posible, secret/PII scan, npm pack audit y checksum.
2. Publicar GitHub Release y npm solo después de pasar todos los jobs; proteger credenciales
   de publicación con 2FA/provenance y fijar Actions de terceros por SHA.
3. Landing estática en Vercel con manifest generado durante release, no dependencia cliente
   obligatoria del API "latest" de GitHub. Detectar OS como sugerencia, siempre mostrar todas
   las plataformas, versión, arquitectura, requisitos, checksum y enlace a release notes.
4. README principal: modos Desktop/Home Server, tabla de garantías, instalación, lifecycle,
   watcher/power limitations, credenciales, datos, red, updates, uninstall y troubleshooting.
5. Añadir `CONTRIBUTING.md`, `SECURITY.md`, threat model, privacidad/egress, guía de Home
   Server, guía de release, soporte de plataformas y política de fixtures/recon.
6. UI/README/landing repiten: cuenta propia, no afiliado a PUCMM, no garantía, ToS, Desktop
   no corre dormido/apagado y Home Server solo es continuo si el hardware lo es.
7. Camino no-código recomendado: presentar el proyecto a PUCMM IT/registraduría y registrar
   por escrito cualquier respuesta/autorización sin incluirla como garantía hasta tenerla.

**Aceptación:** un tag produce únicamente artifacts aprobados para toda la matriz, con
checksums y release notes; landing ofrece el manifest correcto; un tercero puede elegir modo,
instalar, entender límites, recuperar datos y desinstalar usando solo documentación pública.

---

## Procesos y convenciones

- **Ramas:** `main` → `dev` → `feat/open-source-ready`. Todo el trabajo del giro en esa
  rama de tarea. Las ramas `phase/*` existentes se **preservan** (registro histórico); no
  se borran.
- **Commits:** Conventional Commits, atómicos, sin trailers de atribución de IA.
- **Verificación (obligatoria antes de cerrar fase o commitear):** `npm test`, `npm run
  typecheck`, `npm run lint` y los smokes de la fase. Todos verdes = candidato a "hecho";
  packaging/distribución además exigen probar el artifact, no solo el source checkout.
- **Recon antes de scraper:** ningún scraper se escribe sin ver el HTML real primero
  (convención dura del repo), pero ningún HTML real entra al repo sin sanitizer + PII test.
  Preferir fixtures mínimos/sintéticos sobre páginas completas.
- **Datos reales:** nunca usar credenciales, cuentas o datos académicos reales en CI,
  artifact smokes, fixtures públicos ni logs adjuntos a issues.
- **Dependencias nuevas:** justificar necesidad, licencia y superficie de supply chain;
  preferir APIs del OS o dependencias pequeñas para lifecycle/credentials/notifications.
- **Push/merge/PR:** solo cuando el usuario lo pida explícitamente, vía PR con `gh`
  (`main` → `dev` → tarea), merge commit, sin borrar la rama.

### Matriz mínima de verificación transversal

Cada caso debe existir como test automatizado o smoke reproducible antes del primer release:

| Caso | Resultado requerido |
|---|---|
| Cerrar browser | Agente y watcher siguen; notificación Desktop todavía llega |
| Stop explícito | Watcher/schedules quedan pausados y UI/CLI lo dicen |
| Segunda ejecución | Abre la instancia existente; no duplica timer/scrape |
| Port ocupado por otro proceso | Falla seguro y explica; no salta a origen nuevo |
| Sleep/resume | Registra gap y hace un fresh scan, sin replay |
| Reboot | Servicio vuelve según modo; timers se restauran honestamente |
| Power-off durante schedule | Queda missed/uncertain y se reconcilia; no late submit ciego |
| Crash durante submit | Estado durable `uncertain`; no doble submit automático |
| Sin internet / PUCMM caído | Cache local abre; watcher backoff; recuperación controlada |
| Password/MFA/CAPTCHA | Automatización se detiene y pide intervención |
| Request desde origen web ajeno | API mutante lo rechaza |
| Home Server sin HTTPS | No acepta onboarding/credenciales por LAN insegura |
| Chromium ausente/corrupto | First-run repara o da diagnóstico accionable |
| Upgrade/migración fallida | Backup recuperable y versión anterior no corrompe datos |
| Backup/restore | Restore verificado produce datos coherentes |
| Erase/uninstall | No quedan secretos ni datos salvo preservación elegida |
| Egress | Solo destinos del contrato; externos opcionales apagados |
| npm/standalone artifact | Incluye runtime/assets/notices y excluye fixtures/hosted/tests |
| OS/CPU target | Install + start + health + fixture smoke + uninstall en runner nativo |

---

## Limitaciones honestas

- **No existe continuidad sin hardware activo.** Desktop se pausa con sleep/offline/off;
  Home Server solo es 24/7 si el servidor, red y corriente también lo son.
- **Cerrar browser no equivale a cerrar mikampus.** El agente queda vivo hasta `stop`,
  logout/uninstall o decisión del OS; esto se muestra y se puede controlar.
- **Los gaps pierden información.** Si un cupo abrió y cerró mientras no había watcher,
  mikampus no puede reconstruirlo después.
- **Wake timers no son garantía.** Dependen de OS, firmware, energía y sleep state; no
  encienden una máquina completamente apagada.
- **Alertas remotas tienen costo de red.** Fuera de la LAN necesitan VPN o provider
  externo opt-in; no se puede prometer push global y cero infraestructura externa a la vez.
- **Chromium no tiene tamaño/plataforma cerrados aún.** Headless shell y browser del sistema
  se prueban en Fase 3; proxy, librerías Linux y upgrades pueden requerir intervención.
- **Soporte de OS no es universal.** Solo se soportan combinaciones probadas en la matriz;
  compilar en CI no sustituye install/runtime smoke.
- **Firma/notarización está pendiente (P3).** Hasta resolverla habrá posible fricción de
  Gatekeeper/SmartScreen y no se promete doble clic sin warnings.
- **Login real requiere PUCMM.** Tests usan fixtures; credenciales válidas, MFA/CAPTCHA,
  cambios del portal y login end-to-end los confirma el operador sin exponer secretos a CI.
- **Scrapers son frágiles por naturaleza.** Un cambio de PeopleSoft puede requerir release;
  ante incertidumbre se bloquean acciones mutantes y se conservan datos locales.
- **Backups locales no son disaster recovery físico.** Mismo disco no cubre robo/daño;
  export externo es opt-in y responsabilidad del usuario.
- **Local no significa invulnerable.** Malware o un host/root comprometido puede acceder a
  credenciales cuando el agente las usa; keychain/vault reducen exposición, no la eliminan.
- **Riesgo legal residual.** El giro elimina custodia/operación central, no ToS, marca,
  copyright ni toda responsabilidad. Esto no es asesoría legal.

---

## Punteros (para retomar contexto)

- **Chats fuente:** legalidad → sesión `39d6f6b9`; descarte de Electron y forma de
  distribución → `2bcffda4` y `dc8b5f0a`.
- **Docs del repo:** [`PLAN.md`](./PLAN.md) (producto, fases 1–10),
  [`MAPA-MICAMPUS.md`](./MAPA-MICAMPUS.md) (mapa del portal), [`README.md`](./README.md).
- **Memoria del asistente:** `pivot-desktop-opensource`, `legalidad-local-bucket1`,
  `phase-progress`, `portal-map-full`.
