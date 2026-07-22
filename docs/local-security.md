# Contrato local: seguridad, privacidad y red

## Estado y límites

mikampus está migrando a una herramienta local y single-user: tus datos, tu
cuenta y tu hardware. **La implementación actual todavía contiene código y
archivos de despliegue hosted heredados; no deben desplegarse ni usarse.** Su
retiro de `HEAD` es trabajo de la Fase 1.

El proyecto no está afiliado, autorizado ni respaldado por PUCMM. Úsalo solo
con tu propia cuenta y bajo tu responsabilidad. La automatización puede violar
los términos de PUCMM o causar consecuencias académicas; la licencia MIT no
garantiza legalidad, seguridad ni impide que terceros rehosteen un fork. Esto
no es asesoría legal.

P1 (retirar hosted de `HEAD`) y P2 (evaluar el nombre "mikampus") bloquean el
primer paquete, instalador o release público. No se publica ninguno mientras
sigan abiertos.

## Contrato de egress, versión 1

En runtime local normal, PUCMM es el único destino externo requerido. No hay
telemetría, analytics ni update checks automáticos. El navegador Playwright
puede comunicarse con PUCMM únicamente para login, sincronización y acciones
solicitadas o consentidas por el operador.

| Destino | Predeterminado | Datos permitidos |
| --- | --- | --- |
| PUCMM | Activado cuando el operador inicia una operación | Credenciales y tráfico académico estrictamente necesarios |
| CDN de Playwright | Solo durante instalación/actualización explícita del browser | Versión, plataforma e IP de descarga; nunca credenciales PUCMM |
| GitHub Releases, npm, Vercel | Solo distribución o update check explícito futuro | Versión, plataforma e IP de descarga; nunca datos académicos |
| Webhook, push, ntfy u otros adaptadores | Desactivado | Solo payload mínimo declarado y con opt-in explícito |

Cualquier destino adicional requiere actualizar este contrato, una prueba de
egress y una decisión explícita del usuario. El runtime de esta rama aún no
implementa ese enforcement: es un requisito verificable antes del primer
release, no una afirmación sobre el código heredado.

## Threat model

| Amenaza | Límite y mitigación requerida |
| --- | --- |
| Proceso local malicioso | Puede leer datos accesibles al usuario. Credential store y permisos reducen exposición, no protegen un host comprometido. |
| Página web contra localhost | La Fase 1 exige token del launcher, cookie HttpOnly/SameSite, CSRF y validación estricta de Origin/Host. |
| Otro equipo de la LAN | Desktop se limita a loopback. Home Server usa loopback + SSH por defecto; LAN requiere HTTPS, pairing y auth. Nunca port forwarding directo. |
| Robo de backups | Backups se cifran/protegen como datos académicos; una copia en el mismo disco no cubre robo o daño físico. |
| Dependencia comprometida | Lockfile, revisión de licencias/notices, CI con scan y fijación por integridad antes de releases. |
| Home Server expuesto por error | Bind loopback por defecto, health local, documentación de túnel SSH y ninguna guía para exponerlo a Internet. |

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
