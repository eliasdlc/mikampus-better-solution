# ADR 0002: ciclo de vida de datos, notificaciones y updates

**Estado:** aceptado para la Fase 4 (2026-07-22).

## Contexto

Hasta la Fase 3, mikampus podía correr durablemente pero no podía *entregarse*:
el esquema se recreaba con `CREATE TABLE IF NOT EXISTS` sin número de versión,
los backups dependían de que el equipo estuviera encendido a las 3:30, el dedupe
de notificaciones vivía en memoria del proceso, las capturas de error caían en
`./screenshots` del CWD, y "borrar mis datos" borraba filas pero dejaba
credencial, copias y capturas del portal en disco.

## Decisiones

### 1. Versión de esquema con baseline adoptada

`PRAGMA user_version` es la verdad. La versión 1 es el esquema idempotente
histórico: **no se re-deriva** en migraciones porque hay bases reales que ya lo
tienen, y reescribirlas sería más riesgoso que adoptarlas. Una base con tablas y
`user_version = 0` se adopta como baseline sin correr nada; de ahí en adelante
cada cambio es una migración numerada, transaccional y registrada en
`schema_migrations`.

**Compatibilidad de rollback declarada.** Cada migración declara
`minCompatibleVersion`: la versión de esquema más vieja cuyo código todavía puede
leer la base. Se guarda en la base misma, así que un binario anterior puede
consultarlo sin conocer migraciones que no existían cuando se compiló. Si el
mínimo declarado es mayor que lo que ese binario entiende, se detiene el arranque
en lugar de escribir a ciegas — que es como se corrompe una base al bajar de
versión.

**Alternativa descartada:** reescribir todo el esquema como migraciones 1..N.
Habría dado un historial más limpio a costa de tocar tablas que hoy funcionan en
instalaciones reales, sin ganancia para el usuario.

### 2. Backups contra `lastSuccessfulBackup`, no contra el reloj

Un timer diario asume un equipo encendido a esa hora; en Desktop eso es falso la
mayoría de las noches. La copia se decide comparando contra la última copia
verificada, igual que el watcher se compara contra su `lastCheckedAt`, y el
arranque hace la copia atrasada. Una copia solo cuenta como exitosa después de
pasar `integrity_check`, tener esquema legible y contener tablas: sin eso, "tengo
backups" describe una carpeta, no una garantía.

### 3. Dedupe de notificaciones en la base

Un `Map` en memoria hacía que cada reinicio del agente repitiera el mismo aviso.
El dedupe consulta `notifications`, que también es el feed durable y el lugar
donde vive el deep-link de cada aviso.

**Deep-link honesto por plataforma.** En Linux, `notify-send --wait -A` da un
botón real que abre la pantalla correcta. macOS (`osascript`) y el toast de
PowerShell no exponen un click accionable sin una app firmada, así que ahí el
enlace viaja en el cuerpo del mensaje. La UI no promete lo que el OS no da.

### 4. Adaptadores externos como datos, no como promesa

El contrato de egress se hace cumplir con una tabla: cada adaptador guarda su
destino, nace apagado, declara su dependencia externa y su payload literal, y
tiene botón de prueba. Un adaptador apagado no genera un solo request.

### 5. Updates: manual u apagado, nunca automático

Un update-check automático es tráfico periódico a un tercero que el usuario no
pidió. Las únicas políticas son `manual` y `off`. Toda descarga exige el SHA-256
publicado y se descarta si no coincide.

**Límite explícito con la Fase 5.** `runUpdate` implementa el orden
(verificar → detener agente → respaldar → instalar → migrar → validar health) y
deja estado durable con el camino de vuelta si algo falla, pero el paso
`install` lo inyecta el host. El instalador por plataforma —y con él la
resolución de P3 (firma/notarización)— pertenece a la Fase 5. Hasta entonces,
`mikampus update` informa la versión disponible y no reemplaza binarios solo.

### 6. Diagnósticos contenidos, redactados y sin salida implícita

Las capturas del portal son PII por definición y no se pueden redactar. Se
contienen en `app-data/diagnostics` con `0600` y retención propia; el texto sí se
redacta al escribirse. La única salida es una exportación explícita que marca
cuáles son capturas.

## Consecuencias

- Una instalación existente saca una copia `pre-upgrade-v1-*` la primera vez que
  arranca con esta versión. Es esperado y es el camino de retorno.
- El paso `install` del updater queda sin implementación real hasta la Fase 5:
  el flujo está probado con pasos inyectados, no contra un artefacto firmado.
- El deep-link accionable solo existe en Linux hasta que haya app empaquetada y
  firmada en macOS/Windows.
- `screenshots/` deja de recibir escrituras del runtime. Las capturas viejas de
  recon que existan en un checkout local son residuo previo: la carpeta está en
  `.gitignore` y nunca se publicó, pero conviene borrarla a mano.
