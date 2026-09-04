# Contrato local: seguridad, privacidad y red

## Estado y límites

mikampus es una herramienta local y single-user: tus datos, tu cuenta y tu
hardware. No se incluye ni se soporta un despliegue hosted o multiusuario.

El proyecto no está afiliado, autorizado ni respaldado por PUCMM. Úsalo solo
con tu propia cuenta y bajo tu responsabilidad. La automatización puede violar
los términos de PUCMM o causar consecuencias académicas; la licencia MIT no
garantiza legalidad, seguridad ni impide que terceros rehosteen un fork. Esto
no es asesoría legal.

P2 (evaluar el nombre "mikampus") bloquea el primer paquete, instalador o
release público. No se publica ninguno mientras siga abierto.

## Contrato de egress, versión 2

En runtime local normal, PUCMM es el único destino externo requerido. No hay
telemetría, analytics ni update checks automáticos. El navegador Playwright
puede comunicarse con PUCMM únicamente para login, sincronización y acciones
solicitadas o consentidas por el operador.

| Destino | Predeterminado | Datos permitidos |
| --- | --- | --- |
| PUCMM | Activado cuando el operador inicia una operación | Credenciales y tráfico académico estrictamente necesarios |
| CDN de Playwright | Solo durante instalación/actualización explícita del browser | Versión, plataforma e IP de descarga; nunca credenciales PUCMM |
| GitHub Releases, npm, Vercel | Solo con `mikampus update` o el botón de Ajustes; nunca en automático | Versión, plataforma e IP de descarga; nunca datos académicos |
| Webhook, push, ntfy u otros adaptadores | Desactivado; se agregan apagados | Solo payload mínimo declarado y con opt-in explícito |

Cualquier destino adicional requiere actualizar este contrato, una prueba de
egress y una decisión explícita del usuario.

### Cómo lo hace cumplir el runtime

- **Update-check.** La política vive en la base (`update.policy`) y solo admite
  `manual` u `off`; no existe el modo automático. Con `off` no se emite un solo
  request. Toda descarga exige el SHA-256 publicado y se descarta si no coincide.
- **Adaptadores de notificación.** Se registran apagados y muestran destino,
  dependencia externa y payload literal antes de encenderse. El payload es
  título, texto corto, urgencia y un enlace a `127.0.0.1`; nunca credenciales,
  notas ni identificadores del portal. Un adaptador apagado no genera tráfico
  (`scripts/test-notifications.mjs` lo verifica).
- **Backups.** Se escriben solo en la carpeta de datos o en la ruta que el
  usuario elija a mano. No hay respaldo a la nube, ni silencioso ni opcional.

## Datos en disco: dónde vive cada cosa

Todo lo persistente cuelga de app-data (`MIKAMPUS_DATA_DIR`, o el volumen del
Home Server): base SQLite, vault, copias, runtime, browser y diagnósticos.
Nada se escribe en el CWD del proceso ni junto al ejecutable.

- **Esquema versionado.** `PRAGMA user_version` es la verdad; cada migración es
  numerada y transaccional. Antes de la primera migración pendiente sobre una
  base con datos se guarda una copia `pre-upgrade-vN-*.sqlite`. Si una migración
  falla, se revierte entera y el error indica qué archivo restaurar. Cada
  migración declara desde qué versión de esquema puede seguir leyéndola una
  versión anterior de la app; una base más nueva que no lo declare detiene el
  arranque en vez de escribirse a ciegas.
- **Copias.** Se decide contra la última copia exitosa, no solo por reloj: un
  equipo apagado a la hora programada hace la copia atrasada al volver. Se crean
  con `VACUUM INTO`, se verifican (integridad, esquema y contenido) y recién ahí
  cuentan como exitosas. **Una copia en el mismo disco no es disaster recovery:**
  no cubre robo, incendio ni un disco muerto. Exportar a otro medio es manual.
- **Diagnósticos.** Viven en `app-data/diagnostics` con permisos `0600`, se
  redactan al escribirse (tokens de estado de PeopleSoft, EMPLID, matrícula,
  cookies y contraseñas) y tienen retención propia. Las capturas no se pueden
  redactar: su contención es la carpeta, y solo salen de ahí con una exportación
  explícita que además avisa cuáles son capturas del portal. `MIKAMPUS_DIAGNOSTICS=off`
  las desactiva del todo.
- **Salida.** El preview de borrado enumera cada ruta y cada secreto antes de
  eliminar nada. Desde la UI se borran datos, credencial, copias y diagnósticos;
  `mikampus erase-data --yes` —que detiene el agente primero— elimina además el
  archivo de base, el vault, el runtime y el browser descargado. `--keep-backups`
  conserva únicamente las copias; el secreto nunca se conserva.

## Threat model

| Amenaza | Límite y mitigación requerida |
| --- | --- |
| Proceso local malicioso | Puede leer datos accesibles al usuario. Credential store y permisos reducen exposición, no protegen un host comprometido. |
| Página web contra localhost | Cookie HttpOnly/SameSite=Strict, CSRF y validación estricta de Origin/Host; las mutaciones sin Origin válido se rechazan. El token emitido por launcher se incorpora con el runtime durable. |
| Otro equipo de la LAN | El core de esta fase se limita a loopback. Home Server se accede por túnel SSH; una futura exposición LAN requerirá HTTPS, pairing, sesiones y CSRF mediante reverse proxy explícito. Nunca port forwarding directo. |

| Robo de backups | Backups se cifran/protegen como datos académicos; una copia en el mismo disco no cubre robo o daño físico. |
| Dependencia comprometida | Lockfile, revisión de licencias/notices, CI con scan y fijación por integridad antes de releases. |
| Home Server expuesto por error | Bind loopback por defecto, health local, documentación de túnel SSH y ninguna guía para exponerlo a Internet. |

## Credenciales y trabajo desatendido

Usuario y contraseña del portal viven en un solo archivo del usuario,
`credenciales.env` dentro de la carpeta de datos, en texto claro y con permisos
0600. Iniciar sesión lo escribe tras verificar contra el portal; cerrar sesión o
borrar datos lo vacía; la persona puede editarlo o vaciarlo a mano y el cambio
aplica en la próxima operación, sin reiniciar. La sesión de mikampus existe
mientras el archivo tenga credencial: con credencial, abrir la app es entrar;
sin ella, ninguna cookie vale. Watcher y disparos programados usan esa misma
credencial y se detienen si desaparece. Un rechazo de password vacía el archivo
y cierra la sesión; MFA, CAPTCHA o portal caído detienen la automatización sin
tocarlo. No se realizan reintentos de login en bucle.

El costo elegido es explícito: la contraseña está en claro en disco. Lo que la
protege es el permiso del archivo y que nunca entra en copias de seguridad,
diagnósticos ni fixtures.

El cifrado protege copias y archivos extraviados; no protege un host local ya
comprometido, donde un proceso malicioso podría usar un secreto mientras el
agente tiene acceso.

## Fixtures y auditoría pública

Los fixtures existen para probar parsers sin tocar el portal. Deben ser DOM
mínimo y sintético; se permite un fragmento sanitizado solo cuando conservar su
estructura es necesario para cubrir un selector. Nunca se versionan credenciales,
cookies, `ICSID`, `ICStateNum`, matrícula/EMPLID real, request IDs, nombres de
estudiante, capturas, diagnósticos ni HTML crudo. El inventario
[`fixtures/manifest.json`](../fixtures/manifest.json) registra el propósito de
cada excepción heredada; `test-fixture-policy.mjs` rechaza entradas sin revisión,
obsoletas o mayores de 300 KiB. No se admiten páginas completas nuevas.

`npm run audit:public` inspecciona los archivos versionados de `HEAD` y falla
ante patrones de secretos o PII conocida en fixtures. `npm run audit:history`
aplica el mismo detector a cada commit alcanzable desde ramas locales y remotas,
sin imprimir valores coincidentes. Es un detector de regresiones, no una prueba
matemática de ausencia de secretos: cualquier hallazgo real exige revocación y
evaluación separada de reescritura de historia.
