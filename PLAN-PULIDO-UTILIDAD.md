# mikampus — Plan de pulido de utilidad para lanzamiento

> **Gate obligatorio de producto.** Este plan se ejecuta antes de cerrar
> [`PLAN-LOCAL-OPENSOURCE.md`](./PLAN-LOCAL-OPENSOURCE.md) y antes de crear el primer tag
> público. La distribución local puede estar técnicamente lista y aun así no ser un producto
> útil: este documento cierra esa brecha.

---

## Estado actual

- **Fecha del diagnóstico:** 2026-07-22.
- **Rama designada:** `feat/single-user-secure`, preservada como rama histórica de la fase.
- **Estado:** plan aprobado; implementación pendiente.
- **Dependencia de release:** las fases de distribución y CI pueden seguir validándose en
  source, pero no se publica npm, GitHub Release, tag estable ni landing de descarga hasta
  cerrar P0–P6.
- **Evidencia revisada:** interfaz en ejecución, base SQLite local, rutas web, endpoints,
  parsers de PeopleSoft, cálculos académicos y suites específicas existentes.

### Resultado que debe producir este plan

Al abrir mikampus, un estudiante debe poder responder sin investigar el portal:

1. ¿Qué clase tengo ahora o después, y dónde es?
2. ¿Qué fecha académica importante viene?
3. ¿Qué tengo que preparar para inscribirme?
4. ¿Mi información está actualizada y de qué fuente salió?
5. ¿Cómo está cambiando mi índice y qué resultados todavía son alcanzables?

Si alguna respuesta no puede obtenerse de PeopleSoft, mikampus debe explicar la limitación
y la acción posible. Nunca debe sustituir un dato ausente por una inferencia que parezca
confirmada.

---

## Diagnóstico verificado

| Feedback | Causa encontrada | Decisión de producto |
|---|---|---|
| Inicio dice que no se sincronizó y no muestra clases | El horario puede existir con etiqueta de ciclo pero sin STRM. [`Dashboard.tsx`](./web/src/routes/Dashboard.tsx) solo consulta cuando el ciclo actual tiene `code`; [`terms.js`](./src/terms.js) y [`terms.ts`](./src/shared/terms.ts) además pueden crear identidades contradictorias al tratar una etiqueta como código e inferir el ciclo por mes. | Corregir identidad y reconciliación de ciclos antes de rediseñar Inicio. El estado de sincronización proviene de la última operación real, no de si una query encontró filas bajo una clave concreta. |
| Planear e Inscripción se sienten duplicados | [`Planear.tsx`](./web/src/routes/Planear.tsx), [`Planner.tsx`](./web/src/routes/Planner.tsx) e [`Inscripcion.tsx`](./web/src/routes/Inscripcion.tsx) dividen un mismo trabajo y mantienen contexto de ciclo por separado. | Una sola sección **Inscripción**, organizada como flujo Plan → Grupos → Carrito y ejecución. |
| Horario carece de profesor y jerarquía | [`Horario.tsx`](./web/src/routes/Horario.tsx) prioriza código y hora; [`WeeklyGrid.tsx`](./web/src/components/WeeklyGrid.tsx) deja el profesor en un tooltip nativo. View My Classes no expone siempre el profesor, mientras Class Search sí puede hacerlo. | Enriquecer por fuente sin destruir datos ricos y ordenar cada clase como materia → hora → aula → profesor → NRC. |
| “Ventana publicada” y watcher no funcionan | La pantalla asume un próximo STRM y no ofrece selector. El backend exige ciclo y ventana válidos antes de activar el watcher. El parser obtiene un período general, no necesariamente la cita personal. | Selector de ciclo común; renombrar a **Período general de inscripción**; separar **Tu hora de inscripción**; bloquear el watcher con una acción concreta para resolver lo que falta. |
| Faltan próximas fechas | No existe adaptador del calendario académico oficial. | Importar y cachear fechas públicas de PUCMM; mostrarlas en Inicio con fuente, vigencia y enlace oficial. |
| Metas no explica el mejor escenario | La fórmula ponderada de [`gpa.ts`](./src/shared/gpa.ts) es válida, pero la UI mezcla materias en curso de ciclos distintos y solo muestra el horizonte final. La reconstrucción por intentos repetidos puede diferir del acumulado publicado por PeopleSoft. | Separar mejor caso de este ciclo y mejor caso hasta graduación; usar el acumulado de PeopleSoft como baseline; explicar fórmula y suspender la proyección si los datos no reconcilian. |
| Gráfica pequeña y sin interacción | [`Academico.tsx`](./web/src/routes/Academico.tsx) dibuja el GPA de cada período en 132×34, sin ejes, detalle ni trayectoria acumulada. | Gráfica principal de índice acumulado por ciclo, escala fija 0–4, serie secundaria del período y detalle por hover, foco y tap. |
| Señales sin prioridad útil | [`insights.ts`](./src/shared/insights.ts) devuelve un orden fijo. La tendencia de tres ciclos puede llamarse “subiendo” aunque el último ciclo haya bajado. | Separar cambio reciente de tendencia de mediano plazo y ordenar por severidad, actualidad y posibilidad de acción. |
| Actualizar no es universal | [`Layout.tsx`](./web/src/components/Layout.tsx) actualiza al montar; [`server.js`](./src/server.js) ya tiene TTL parciales, pero no un loop periódico ni invalidación completa de dependencias. | Un solo orquestador de sincronización, control global, estados por fuente y actualización periódica stale-aware del carrito. |

### Restricción de datos importante

El reglamento académico publicado por PUCMM indica que, al repetir una asignatura, se toma
la última calificación para el índice. Los datos que PeopleSoft publica pueden no reconstruirse
de esa forma. Hasta reconciliar ambas fuentes, mikampus no escogerá silenciosamente una política:

- el acumulado publicado por PeopleSoft será el baseline de una proyección;
- el cálculo por materias se conservará como auditoría;
- si ambos no coinciden dentro de la precisión oficial, se muestra “No podemos proyectar
  con confianza” y la diferencia, sin fabricar una cifra;
- los fixtures de prueba serán sintéticos y no contendrán historial académico real.

Fuente pública: [Reglamento académico de grado de PUCMM](https://pucmm.edu.do/wp-content/uploads/2026/07/reglamento-academico-grado.pdf).

---

## Dirección de producto y diseño

### Sujeto, audiencia y trabajo de la interfaz

- **Sujeto:** la jornada académica real de un estudiante PUCMM, conectada con su progreso
  y el siguiente proceso de inscripción.
- **Audiencia:** estudiantes que consultan la app con prisa, especialmente desde móvil,
  antes de una clase o durante una ventana de inscripción.
- **Trabajo principal:** convertir datos dispersos del portal en una secuencia temporal y
  accionable, sin esconder de dónde vienen ni cuándo se actualizaron.

### Sistema visual que se conserva

No se introduce un rebranding. Se mantienen los tokens de [`index.css`](./web/src/index.css):

- papel `#f7f7f5`, tinta `#16181d`, superficie blanca y azul `#2557d6` en claro;
- fondo `#16181d`, superficies `#1e2128`/`#252932` y azul `#4f7dea` en oscuro;
- verde, ámbar y rojo reservados para estados reales, no decoración;
- Bricolage Grotesque para títulos, Inter para lectura y JetBrains Mono para horas,
  códigos y cifras;
- color estable por materia como firma transversal del horario.

### Único gesto distintivo: la línea académica

Inicio se recordará por una **línea académica cronológica**: una sola columna conecta la
clase actual/próxima, el resto del día y las fechas institucionales siguientes. El color
de la materia marca clases; las fechas oficiales usan tinta/acento y no compiten con ellas.
La línea comunica una verdad del producto —el tiempo manda— en vez de ser decoración.

Se descarta una cuadrícula de cards iguales porque haría que una fecha de pago, un watcher
apagado y una clase en cinco minutos parezcan igualmente importantes. Fuera de la línea
académica, la interfaz permanece sobria y sin animación ornamental. Solo se anima, respetando
`prefers-reduced-motion`, el cambio de estado que acaba de ocurrir.

### Jerarquías objetivo

```text
INICIO
┌────────────────────────────────────┬──────────────────────┐
│ AHORA / PRÓXIMA CLASE              │ Estado de datos      │
│ Nombre · hora · aula · profesor    │ Actualizado hace…    │
├────────────────────────────────────┤ Acción solo si falla │
│ LÍNEA ACADÉMICA                    ├──────────────────────┤
│ ● clase actual                     │ Próximo ciclo        │
│ ○ siguiente clase                  │ preparación resumida │
│ │                                  └──────────────────────┘
│ ◆ próxima fecha PUCMM
│ ◆ fecha siguiente
└───────────────────────────────────────────────────────────┘
```

```text
INSCRIPCIÓN · [Ciclo seleccionado ▾] · datos actualizados hace…
┌ Plan ───────── Grupos y horario ───────── Carrito y ejecución ┐
├────────────────────────────────────┬───────────────────────────┤
│ Contenido de la etapa              │ Contexto de inscripción   │
│                                    │ Período general           │
│                                    │ Tu hora                   │
│                                    │ Validación / watcher      │
└────────────────────────────────────┴───────────────────────────┘
```

En móvil, la columna contextual baja después del contenido principal y una barra de etapa
compacta conserva el ciclo seleccionado. El watcher no ocupa espacio hasta que haya una
sección cerrada, una vigilancia existente o el usuario lo solicite.

---

## Secuencia de ejecución

Las fases son dependientes y se implementan en orden. P0 y P1 corrigen la base compartida;
las pantallas no deben crear workarounds locales para saltárselas.

### P0 — Identidad de ciclos e integridad de datos

**Meta:** una misma actividad académica no puede pertenecer a dos ciclos incompatibles ni
desaparecer porque todavía no se conoce su STRM.

1. Definir una identidad interna estable de ciclo con:
   - STRM externo opcional y validado como código, nunca como etiqueta libre;
   - etiqueta normalizada;
   - fechas de inicio/fin cuando una fuente las publique;
   - aliases y procedencia de cada campo;
   - estado `current`, `next`, `past` calculado por rango y evidencia, no solo por mes.
2. Hacer que schedule, grades, cart, plans, goals, enrollment windows y watcher se refieran
   a esa identidad, aunque el adaptador externo aún reciba STRM.
3. Crear una migración transaccional e idempotente que:
   - haga backup previo según el lifecycle existente;
   - detecte etiquetas guardadas como código;
   - fusione duplicados conservando el valor más rico y reciente por campo;
   - reasigne relaciones sin perder filas;
   - aborte y restaure ante una colisión ambigua.
4. Corregir `reconcileTerms()` y `cycleLabel()` para no convertir automáticamente abril
   en enero ni tratar cualquier `enrollments.term` como STRM.
5. Cambiar las queries del dashboard y horario para aceptar la identidad canónica; el
   estado “No sincronizado” depende del registro de sync del ciclo, no de `rows.length`.
6. Agregar telemetría exclusivamente local de reconciliación: aliases unidos, fuentes en
   conflicto y último resultado, redactada para diagnostics.

**Aceptación P0**

- Un horario guardado solo con etiqueta aparece en Inicio y Mi horario.
- El caso sintético de un ciclo que empieza a finales de abril no se etiqueta como enero.
- Cuando después aparece el STRM, el ciclo se enriquece; no se duplica.
- Migrar dos veces produce el mismo resultado y no pierde horario, carrito, ventanas,
  notas, planes, metas, watcher ni schedules.
- Un conflicto imposible de resolver no mezcla datos y deja un diagnóstico accionable.

### P1 — Orquestador universal de sincronización

**Meta:** toda la app comparte una definición de frescura y una sola cola segura para
consultar PeopleSoft.

1. Reemplazar la lista manual de refresh por un registro de fuentes con:
   `key`, dependencias, TTL, permiso requerido, operación, queries afectadas, última
   ejecución, último éxito y error actual.
2. Ordenar dependencias: descubrir/reconciliar ciclos antes de horario, carrito, ventanas
   y watcher; recalcular proyecciones después de notas y progreso.
3. Exponer un control global con:
   - **Actualizar lo necesario:** solo fuentes vencidas;
   - **Actualizar todo ahora:** fuerza fuentes elegibles sin evadir consentimiento;
   - detalle por fuente y progreso de la cola.
4. Ejecutar un tick liviano cada minuto. El carrito conserva un TTL inicial de diez
   minutos y solo se consulta si existe un ciclo de inscripción relevante.
5. Evitar operaciones solapadas; watcher, disparo programado y refresh comparten lock,
   prioridad y backoff. Un submit nunca se interrumpe para refrescar el carrito.
6. Reanudar después de sleep/offline con una sola actualización fresca, no replay de ticks.
7. No persistir credenciales nuevas para soportar refresh. Sin sesión/consentimiento, el
   estado es `paused` con última actualización y acción de reautenticación.
8. Invalidar por evento todas las queries dependientes, incluidos ciclo, ventanas,
   calendario, metas, señales y dashboard.

**Aceptación P1**

- Una pestaña abierta refleja un cambio del carrito sin reload manual dentro del TTL.
- Diez componentes que piden refresh simultáneo generan una sola operación por fuente.
- El botón universal explica qué actualizó, qué omitió y por qué.
- Offline, sesión expirada y backoff conservan datos cacheados y no producen loops.
- Un watcher o submit activo tiene prioridad y nunca recibe una segunda acción mutante.

### P2 — Inscripción unificada

**Meta:** planificar y ejecutar una inscripción es un único recorrido con un ciclo común.

1. Convertir `/inscripcion` en el workspace canónico con tres etapas reales:
   **Plan**, **Grupos y horario**, **Carrito y ejecución**.
2. Retirar “Planear” de navegación primaria y conservar redirects con parámetros desde
   `/planear`, `/planner` y `/builder` hacia la etapa equivalente.
3. Crear un selector de ciclo visible en el header y persistido en URL. Todo plan, catálogo,
   horario candidato, carrito, ventana y watcher se deriva de esa selección.
4. Resolver un ciclo sin STRM desde el mismo lugar: ofrecer “Buscar ciclos en PeopleSoft”
   y actualizar la identidad P0; no enviar un término implícito al backend.
5. Reescribir la columna contextual:
   - **Período general de inscripción:** rango publicado, fuente, ciclo y último sync;
   - **Tu hora de inscripción:** dato personal confirmado o entrada manual claramente
     marcada; nunca inferirla del período general;
   - **Validación previa:** holds, choques, prerrequisitos y disponibilidad;
   - **Watcher de cupos:** activable solo con ciclo y secciones vigilables.
6. Conservar planes y carrito al cambiar de etapa. Antes de cambiar de ciclo con trabajo
   sin guardar, explicar el impacto y permitir cancelar.
7. Usar verbos consistentes: “Agregar al plan”, “Elegir grupo”, “Enviar al carrito”,
   “Validar carrito”, “Programar inscripción”.

**Aceptación P2**

- Un usuario sin STRM visible puede descubrir y seleccionar el ciclo sin salir del flujo.
- El watcher nunca responde solamente “elige un ciclo”: muestra el selector o la acción
  exacta que falta.
- El período general no se presenta como la hora personal.
- Plan → grupos → carrito conserva ciclo y selecciones en desktop, móvil y reload.
- Los redirects históricos no rompen bookmarks existentes.

### P3 — Inicio útil y calendario académico

**Meta:** Inicio prioriza el día académico real y la siguiente fecha institucional.

1. Reestructurar Inicio según la línea académica:
   - clase en curso o próxima clase como hero;
   - agenda restante del día;
   - próximas 3–5 fechas institucionales;
   - holds solo cuando son accionables;
   - próximo ciclo como preparación secundaria.
2. Mostrar en cada clase nombre, inicio/fin, aula prominente y profesor cuando esté
   confirmado. Si hoy no hay clases, decir cuándo es la próxima; no convertirlo en un
   estado de sincronización fallida.
3. Crear un adaptador read-only para el
   [calendario académico oficial](https://pucmm.edu.do/calendarios/calendario-academico/)
   y, cuando corresponda, el
   [calendario de preinscripción](https://pucmm.edu.do/calendarios/calendario-de-preinscripcion/).
4. Extraer datos estructurados del HTML público, cachearlos en SQLite con URL, identificador,
   título, inicio/fin, campus/categoría si existe, fecha de fetch y último éxito.
5. Refrescar como máximo una vez al día o al iniciar si está stale. Un fallo nunca bloquea
   Inicio; se usa caché con indicador de antigüedad.
6. Interpretar fechas sin hora en `America/Santo_Domingo` para evitar desplazamientos UTC.
7. Dedupe por identificador oficial y, como respaldo, título normalizado + rango. Abrir el
   evento o la fuente oficial desde la UI; no copiar descripciones extensas.

**Aceptación P3**

- Con horario sincronizado, Inicio no muestra el CTA “Traer desde Mi horario”.
- En un día con reuniones, la agenda coincide con día local y rangos de vigencia.
- Las fechas se ordenan cronológicamente, no cambian de día por timezone y enlazan a PUCMM.
- Sin internet se conserva la última caché y se informa su antigüedad.
- Un cambio de markup falla de forma visible en diagnostics, sin romper la pantalla.

### P4 — Horario enriquecido y legible

**Meta:** identificar materia, momento, lugar y profesor de un vistazo.

1. Introducir merge por campo y procedencia para secciones:
   - `null` o texto truncado no reemplaza un valor más rico;
   - horario/estado del ciclo vienen de View My Classes;
   - profesor y metadatos de sección pueden enriquecerse desde Class Search;
   - cualquier discrepancia queda trazable localmente.
2. Correlacionar primero por STRM + class number; usar course code/sección solo si es
   inequívoco. No adivinar profesores entre grupos.
3. Hacer recon read-only antes de añadir un scraper de pantalla nueva. Todo fixture público
   es mínimo, sintético y pasa la política de sanitización.
4. Rediseñar lista y bloques:
   - nombre de materia como nivel principal;
   - hora tabular y estado temporal;
   - aula completa con icono de ubicación y contraste suficiente;
   - profesor o “Profesor no publicado”;
   - código, NRC y modalidad como metadatos secundarios.
5. Al click, tap o foco, abrir detalle accesible con componentes, fechas, aula, profesor,
   NRC, créditos y fuente/actualización.
6. Mantener lista como default móvil, grid semanal en desktop, impresión apaisada e ICS.

**Aceptación P4**

- Un sync de horario no borra un profesor previamente enriquecido.
- Dos secciones similares no intercambian profesor o aula.
- Lista, grid, detalle e impresión muestran la misma información esencial.
- Toda acción por hover tiene equivalente de teclado y touch.

### P5 — Notas, trayectoria y señales confiables

**Meta:** explicar el progreso sin falsas certezas ni visualizaciones engañosas.

1. Persistir y mostrar por separado:
   - acumulado oficial reportado por PeopleSoft;
   - acumulado reconstruido por materias;
   - estado de reconciliación y precisión oficial.
2. Dividir Metas en dos horizontes:
   - **Al cerrar este ciclo:** solo créditos en curso del ciclo seleccionado;
   - **Hasta graduarte:** créditos pendientes autoritativos del advisement.
3. Para cada horizonte mostrar baseline, créditos futuros, promedio asumido, resultado
   exacto a dos decimales y cómo lo redondearía PeopleSoft. Etiquetarlo como escenario,
   nunca promesa.
4. Añadir “Cómo se calcula” con la fórmula ponderada y timestamps de notas/progreso. Si
   faltan créditos o la reconciliación falla, ocultar el número y explicar qué actualizar.
5. Sustituir el sparkline por una gráfica amplia:
   - escala fija 0–4 y líneas de referencia útiles;
   - índice acumulado tras cada ciclo como serie principal;
   - GPA del período como serie secundaria opcional;
   - tooltip/focus con ciclo, ambos índices y créditos GPA;
   - resumen textual accesible y soporte touch.
6. Corregir señales:
   - `recent-change`: último ciclo completo contra el anterior;
   - `rolling-trend`: tendencia explícita de tres ciclos, sin llamarla cambio reciente;
   - áreas, carga, retiros y repeticiones como contexto, no causalidad.
7. Añadir metadatos deterministas de `severity`, `recency`, `actionability` y `confidence`.
   Orden: bloqueo/acción inmediata → deterioro reciente → riesgo vigente → contexto.
8. Presentar una señal principal de ancho completo bajo “Lo más importante” y el resto
   bajo “Contexto”. Los colores de alarma solo aparecen ante riesgo real.

**Aceptación P5**

- Las materias futuras no inflan el mejor caso del ciclo actual.
- Una discrepancia de acumulados detiene la proyección y explica el conflicto.
- La serie acumulada se verifica con fixtures de varios ciclos y orden cronológico.
- Hover, foco y tap revelan el mismo dato; el lector de pantalla recibe un resumen útil.
- Una caída reciente no aparece como “subiendo” por una comparación de tres ciclos.
- Una señal antigua no desplaza una alerta actual más accionable.

### P6 — Gate integrado de utilidad y lanzamiento

**Meta:** demostrar que los nueve problemas están resueltos juntos, no solo por componente.

1. Crear journeys reproducibles con fixtures sintéticos:
   - ciclo actual con etiqueta y STRM todavía desconocido;
   - STRM descubierto después, sin duplicación;
   - día con clases, día vacío y reunión fuera de vigencia;
   - ciclo próximo seleccionable, período general ausente/presente y watcher;
   - historial con repetición, acumulados coincidentes y discrepantes;
   - calendario fresco, stale, offline y markup inválido;
   - carrito que cambia después del TTL durante una sesión abierta.
2. Verificar responsive en 390, 768 y 1440 px, temas claro/oscuro e impresión de horario.
3. Verificar teclado completo, foco visible, nombres accesibles, reduced motion y contraste.
4. Ejecutar la suite completa, typecheck y lint. La validación de release conserva además
   los smokes de artifact definidos en `PLAN-LOCAL-OPENSOURCE.md`.
5. Hacer un smoke local read-only contra el ciclo actual y próximo. Inscribir, dar de baja,
   disparar un schedule o activar watcher real requiere acción explícita del operador.
6. Actualizar README y screenshots para que navegación, límites de sync, calendario y
   proyecciones coincidan con el producto entregado.

**Aceptación P6**

- Cada uno de los nueve puntos tiene al menos una prueba automática y un check manual.
- `npm test`, `npm run typecheck` y `npm run lint` pasan sin errores nuevos.
- No hay overflow a 390 px ni controles exclusivos de hover.
- La app abre offline con sus últimos datos y distingue cacheado, stale, pausado y error.
- Ningún fixture, log, screenshot o documento público contiene datos académicos reales.
- Solo entonces Fases 5 y 6 del plan open source pueden ejecutar el primer tag público.

---

## Matriz transversal de aceptación

| Área | Caso mínimo | Resultado requerido |
|---|---|---|
| Ciclos | etiqueta sin STRM → STRM conocido | una identidad, cero datos perdidos |
| Inicio | sync exitoso con horario válido | agenda visible; no aparece “no sincronizaste” |
| Agenda | reunión fuera de fecha | no aparece como clase de hoy |
| Inscripción | próximo ciclo sin código | selector + descubrimiento, no error terminal |
| Ventana | rango general sin hora personal | conceptos y fuentes separados |
| Watcher | ciclo/sección inválidos | control deshabilitado con acción concreta |
| Horario | profesor solo en catálogo | enriquecimiento seguro y persistente |
| Calendario | offline después de un éxito | caché visible con antigüedad y enlace fuente |
| GPA | horizonte actual y final | créditos correctamente acotados y fórmula visible |
| GPA | baseline no reconcilia | proyección suspendida, diagnóstico visible |
| Gráfica | mouse, teclado y touch | mismo detalle por ciclo y resumen accesible |
| Señales | último ciclo cae, ventana de tres mejora | caída reciente priorizada; tendencia separada |
| Sync | carrito stale con app abierta | un refresh, invalidación inmediata, sin solape |
| Seguridad | sin sesión o consentimiento | refresh pausado; no se amplía custodia de credenciales |

---

## Decisiones cerradas para la implementación

1. **Inscripción absorbe Planear.** No se mantiene una segunda sección primaria.
2. **Inicio es temporal, no un mosaico de estados.** Clase y próxima fecha ganan sobre
   watcher apagado, feed histórico o tarjetas informativas.
3. **La fuente se ve.** Períodos, fechas, acumulados y frescura declaran procedencia.
4. **Sin dato significa sin dato.** “Profesor no publicado” y “hora personal no conocida”
   son mejores que una inferencia plausible.
5. **PeopleSoft baseline, cálculo auditable.** Las proyecciones parten del acumulado
   publicado y solo se muestran si la reconstrucción es coherente.
6. **Una cola, un estado de frescura.** Ninguna ruta crea su propio refresh paralelo.
7. **Sin dependencia gráfica nueva por defecto.** SVG/React existente cubre el chart; una
   librería solo entra si accesibilidad y touch no pueden resolverse con menos superficie.
8. **No se cambia la identidad visual.** El pulido invierte en jerarquía, copy y estados;
   no en decoración ni un nuevo sistema de diseño.

---

## Fuera de alcance

- Garantizar cupos o que una inscripción programada tendrá éxito.
- Ejecutar watcher con el equipo apagado o sin conectividad.
- Crear un backend hosted, telemetría remota o calendario propietario.
- Inferir una hora personal de inscripción desde el período general.
- Geolocalización o mapas de aulas sin una fuente oficial y verificable.
- Resolver por código una discrepancia normativa entre el reglamento y PeopleSoft; la app
  la detecta y la hace explícita.
- Rebranding, animaciones decorativas o una librería de charts por conveniencia.

---

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Migración une ciclos que no corresponden | matching conservador, backup, transacción, dry-run diagnóstico y aborto ante ambigüedad |
| PeopleSoft cambia markup | recon previo, fixtures mínimos, compatibility mode y errores por fuente |
| Calendario oficial cambia HTML | preferir datos estructurados, parser aislado, caché y enlace directo |
| Refresh periódico aumenta carga | TTL, una cola, relevancia por ciclo, jitter/backoff y pausa durante submits |
| Enriquecimiento asigna profesor incorrecto | correlación fuerte por STRM/class number; nunca matching ambiguo |
| Proyección parece promesa | lenguaje de escenario, fórmula visible, timestamp y guard de reconciliación |
| Unificación pierde URLs o planes | redirects, estado en URL y tests de persistencia |
| Pulido se convierte en mega-rediseño | tokens existentes, una sola firma visual y aceptación por utilidad |

---

## Cierre y registro de avance

Al terminar cada fase:

1. actualizar su estado y evidencia en este documento;
2. registrar tests, smokes y limitaciones pendientes;
3. revisar el diff contra todos sus criterios de aceptación;
4. no marcarla cerrada si un criterio aplicable queda pendiente;
5. mantener `PLAN-LOCAL-OPENSOURCE.md` como índice del gate y este archivo como fuente de
   verdad del trabajo de producto.

| Fase | Estado | Evidencia de cierre |
|---|---|---|
| P0 — Ciclos e integridad | ⬜ Pendiente | — |
| P1 — Sync universal | ⬜ Pendiente | — |
| P2 — Inscripción unificada | ⬜ Pendiente | — |
| P3 — Inicio y calendario | ⬜ Pendiente | — |
| P4 — Horario enriquecido | ⬜ Pendiente | — |
| P5 — Notas y señales | ⬜ Pendiente | — |
| P6 — Gate de lanzamiento | ⬜ Pendiente | — |

Leyenda: ⬜ pendiente · 🟨 en curso · ✅ hecho · ⛔ bloqueado.
