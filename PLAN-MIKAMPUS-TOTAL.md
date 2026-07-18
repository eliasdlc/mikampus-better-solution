# PLAN — Mikampus total: reemplazar MiCampus y convertirse en la plataforma del estudiante

> Fuente de alcance: [`MAPA-MICAMPUS.md`](./MAPA-MICAMPUS.md), reconstruido el
> 18-jul-2026. Este documento transforma cada capacidad descubierta en una experiencia
> concreta de Mikampus. Ninguna entrada del mapa queda olvidada: cada una termina como
> función nativa, acción asistida, enlace contextual seguro o exclusión explícita y
> auditable.

## 0. Punto de partida real

Mikampus ya resolvió la parte más difícil de una plataforma académica: entiende cursos,
secciones, términos, horario inscrito, notas, pénsum, requisitos, metas, holds, planes y
el carrito como un solo modelo. La base actual está en `src/db.js:27-315`; los datos se
sirven desde cache y se sincronizan explícitamente en `src/server.js:73-395`; la SPA
actual declara sus rutas en `web/src/App.tsx:14-29`; y la navegación todavía refleja las
pantallas construidas por fases en `web/src/components/Layout.tsx:11-37`.

Hoy ya existen:

- horario real por término, agenda, WeeklyGrid, exportación ICS, impresión y baja con
  doble confirmación en `web/src/routes/Horario.tsx`;
- catálogo, búsqueda, planes, constructor de combinaciones, carrito, inscripción,
  watcher y ventanas de inscripción;
- historial de notas, índice, avance, trayectoria, recomendador, metas y señales en
  `web/src/routes/Academico.tsx` y `web/src/routes/Trayectoria.tsx`;
- holds y algunos to-dos, aunque el modelo persistido solo conserva holds.

La brecha ya no es “hacer un clon de MiCampus”. Es conectar la información que
PeopleSoft separa y convertirla en decisiones útiles. MiCampus responde dónde está un
dato. Mikampus debe responder qué significa, qué urge y cuál es el próximo paso seguro.

## 1. Promesa de producto

**Mikampus es el sistema operativo de la vida universitaria.** Al abrirlo, el estudiante
ve su día, su riesgo académico, sus compromisos y su siguiente decisión. No tiene que
saber qué es Academic Records, Student Center, un `STRM` ni una navigation collection.

La plataforma se diseña alrededor de cinco preguntas:

1. ¿Qué tengo hoy y qué cambió desde la última vez?
2. ¿Estoy bien en cada materia o hay algo que atender?
3. ¿Qué debo cursar después y cuál horario me conviene?
4. ¿Hay algo que pueda bloquear mi inscripción, mi pago o mi graduación?
5. ¿Qué trámite tengo pendiente y cómo lo termino sin perderme?

La meta de paridad no es copiar todas las tablas. Una función solo está implementada
cuando el estudiante puede comprenderla y completar su intención desde Mikampus, aunque
la confirmación final de una acción sensible ocurra en una vista segura de MiCampus.

## 2. Cuatro formas de reemplazar una función

Cada capacidad del mapa recibe una modalidad explícita. Esto evita dos extremos: dejar
media universidad fuera o automatizar irresponsablemente pagos y trámites irreversibles.

| Modalidad | Qué hace Mikampus | Ejemplos |
|---|---|---|
| **Nativa** | Lee, organiza y permite completar la intención dentro de Mikampus. | horario, asistencia, búsqueda, planificación, historial, carrito |
| **Nativa protegida** | Ejecuta en PeopleSoft solo después de resumen, reautenticación y confirmación inequívoca. Nunca se programa sola. | drop, swap, formalización de inscripción, cambio de datos de contacto |
| **Handoff guiado** | Prepara contexto y checklist, abre el componente exacto y luego verifica el resultado al volver. Mikampus nunca presiona el botón irreversible. | pagos, depósito directo, transcript oficial, solicitud de graduación |
| **Referencia** | Da estado, explicación y acceso exacto; no replica una utilidad administrativa o externa. | Biblioteca, PVA, Publicaciones, PeopleTools |

Toda pantalla sensible muestra antes de actuar: qué va a cambiar, en qué sistema, si es
reversible, qué evidencia se guardará y cuándo se sincronizó la información usada. Los
flujos de dinero nunca se someten automáticamente. Las evaluaciones profesorales nunca
se rellenan con IA ni se responden en nombre del estudiante.

## 3. Nueva arquitectura de navegación

La navegación deja de copiar módulos administrativos y se organiza por intención. En
desktop usa sidebar; en mobile usa una barra inferior para los cuatro destinos diarios y
un menú “Más”. `⌘K` sigue siendo búsqueda global y gana acciones, documentos y trámites.

| Destino | Ruta | Responde |
|---|---|---|
| **Inicio** | `/` | ¿Qué requiere mi atención ahora? |
| **Hoy** | `/hoy` | ¿Dónde debo estar y cómo voy en mis materias actuales? |
| **Planear** | `/planear` | ¿Qué debo cursar y qué horario me conviene? |
| **Inscripción** | `/inscripcion` | ¿Estoy listo para inscribir y qué ocurrió? |
| **Carrera** | `/carrera` | ¿Cómo va mi avance, índice y graduación? |
| **Finanzas** | `/finanzas` | ¿Qué debo, por qué, cuándo y cuánto costará el próximo ciclo? |
| **Bandeja** | `/bandeja` | ¿Qué mensajes, tareas, acuerdos y alertas tengo? |
| **Trámites** | `/tramites` | ¿Qué documento o proceso necesito y cómo lo completo? |
| **Perfil** | `/perfil` | ¿Qué sabe PUCMM de mí y qué preferencias controlo? |

Las rutas actuales se conservan inicialmente como redirects: `/horario` → `/hoy`,
`/planner` y `/builder` → `/planear`, `/academico` y `/trayectoria` → `/carrera`, y
`/holds` → `/bandeja?tipo=hold`. No se elimina una ruta hasta que sus acciones existan en
el destino nuevo.

### 3.1 Gramática visual: el tiempo académico como material

El sujeto es un estudiante que abre Mikampus entre clases, desde el teléfono y a veces
bajo presión. El trabajo único de la interfaz es orientarlo en pocos segundos. Se
mantienen los tokens, tipografías y colores de materia definidos en `PLAN.md:68-90`; no
se inventa una segunda identidad para los módulos nuevos.

La firma visual evoluciona del WeeklyGrid a una **cinta académica**: una línea continua
que ubica “ahora” dentro del día, el ciclo y la carrera. En Inicio es la próxima clase;
en Hoy recorre las reuniones; en Inscripción marca preparación → ventana → resultado; en
Carrera conecta ciclos completados con la graduación proyectada. No es decoración: en
cada superficie codifica secuencia y distancia temporal real.

El riesgo visual deliberado es dejar que el bloque de la próxima materia rompa el marco
normal del layout y actúe como encabezado vivo, teñido con el color estable del curso.
Todo lo demás permanece sobrio: fondo, texto, líneas y un solo acento de acción. Finanzas
no se vuelve verde, Perfil no se vuelve una colección de cards y cada sección evita el
patrón genérico de “título + cuatro métricas + gráfica”. En mobile, la jerarquía es
siempre ahora → riesgo → próxima acción; la información secundaria se revela después.

## 4. Capacidades transversales

### 4.1 Centro de atención

Todos los scrapers producen elementos normalizados de atención: `info`, `cambio`,
`próximo`, `riesgo` o `bloqueo`. El Dashboard no consulta nueve módulos para dibujar
nueve cards; consulta una sola bandeja priorizada. Un hold que impide inscripción está
por encima de un mensaje general, y una clase que comienza en 20 minutos está por encima
de ambos mientras no requieran acción inmediata.

Cada elemento responde cuatro cosas: qué pasó, por qué importa, fecha límite y acción
siguiente. Se puede marcar visto, posponer o resolver. “Resuelto” no se infiere por un
click: se confirma en el próximo sync del sistema fuente.

### 4.2 Sync Center

`/ajustes/sync` muestra cada fuente, último intento, último éxito, término, volumen de
registros y estado real: disponible, vacío, no autorizado, ventana cerrada, necesita
término, contexto inválido, sesión vencida o error de parser. Es la implementación
visible de los estados definidos en `MAPA-MICAMPUS.md:552-568`.

Desde ahí se puede “Actualizar todo lo importante”, pero la cola aplica prioridades,
TTL, rate limits y jitter. Nunca se abren en batch componentes mutantes. Si un parser
falla, la UI conserva el último dato válido con una advertencia; no sustituye el dato por
un arreglo vacío.

### 4.3 Centro de acciones y recibos

Cada mutación genera un recibo local con fecha, intención, estado previo, estado
posterior confirmado, componente fuente y resultado. No guarda tokens, HTML ni PII
innecesaria. El estudiante puede responder “¿sí se formalizó?”, “¿sí se dio de baja?” o
“¿mi solicitud salió?” sin confiar en un toast que desapareció.

### 4.4 Búsqueda global útil

`⌘K` encuentra materias, personas de apoyo, trámites, mensajes, documentos, secciones,
ajustes y acciones. Buscar “índice” ofrece ver el índice, simular notas y entender la
regla; “graduación” ofrece fecha esperada, progreso, solicitud y estado. No expone los
nombres internos de PeopleSoft.

### 4.5 Notificaciones con significado

Las notificaciones no replican cada cambio. Solo salen cuando existe una decisión:
nueva nota publicada, ausencia que cruza un umbral, balance nuevo, fecha de vencimiento,
hold bloqueante, mensaje institucional no leído, evaluación por vencer, ventana de
inscripción publicada, cupo detectado o cambio de aula/horario. Cada categoría se puede
silenciar y elegir como push, email digest o solo Bandeja.

## 5. Secciones del producto

### 5.1 Inicio — el briefing del estudiante

Inicio combina el horario real con el resto del mapa. Su hero mantiene la próxima clase,
pero añade contexto: aula, docente, tiempo para llegar, asistencia acumulada y acciones
de la materia. Debajo aparece un briefing de máximo cinco elementos, ya priorizados:

- “ICC-303 empieza en 35 min · aula B1-204”;
- “Te queda 1 ausencia segura en MAT-270”;
- “Se publicó tu nota de FIS-201”;
- “Tienes un hold que bloqueará la inscripción”;
- “El pago de RD$… vence el viernes”.

Un bloque “Cambió desde tu última visita” resume nuevas notas, mensajes, cargos, holds,
fechas y cambios de horario. Otro bloque “Próximo gran momento” cambia según el ciclo:
inicio de docencia, retiro, inscripción, evaluaciones o graduación. No hay gráficas de
vanidad ni módulos vacíos ocupando espacio.

### 5.2 Hoy — horario real y centro de cada materia

`/hoy` absorbe la vista actual de horario y añade dos vistas: Día y Materias. Semana
conserva el `WeeklyGrid`; Día es la agenda móvil; Materias es el workspace del ciclo.

Cada materia tiene una ficha unificada con nombre, sección, componentes, docente, aula,
fechas, nota parcial/oficial cuando exista, asistencia, ausencias disponibles, eventos
personales y links fijados por el estudiante. El mapa no ofrece syllabus ni tareas
confiables para todos los cursos, por lo que esos datos se muestran solo si PeopleSoft
los publica o si el estudiante los agrega; nunca se inventan.

Innovaciones:

- **Presupuesto de ausencias.** Traduce horas asistidas y ausencias permitidas a “te
  quedan N clases” usando la duración real de las reuniones. Permite simular “si falto el
  jueves” sin alterar PeopleSoft.
- **Semáforo de asistencia.** Seguro, cuidado, crítico o sin datos. Explica el cálculo y
  distingue dato oficial de proyección.
- **Cambio de aula u horario.** Compara snapshots y notifica solo cambios futuros.
- **Buffers personales.** El estudiante puede pedir alertas 10/20/30 minutos antes y
  añadir tiempo entre campus, parqueo o transporte. Es preferencia local.
- **Agenda exportable viva.** ICS por ciclo y feed suscribible; las fechas oficiales
  acotan recurrencias y los cambios actualizan el feed.
- **Histórico de horarios.** Los ciclos pasados se reconstruyen desde la fuente Classic
  preferida y quedan navegables junto a notas y trayectoria.

### 5.3 Planear — del requisito a una semana posible

Unifica Planner, Builder, búsqueda y recomendador. Tiene tres pasos persistentes, no
tres productos separados:

1. **Qué me toca.** Requisitos pendientes, alertas de curso, prerrequisitos conocidos,
   créditos restantes, metas, oferta del ciclo y créditos transferidos.
2. **Qué quiero.** Materias candidatas, carga deseada, prioridades y restricciones
   personales.
3. **Cómo cabe.** Secciones reales, profesores, campus, choques y combinaciones del
   solver.

La recomendación explica cada materia: requisito que cubre, si está ofertada, impacto en
la ruta crítica y por qué fue priorizada. El usuario puede fijar días libres, hora máxima,
campus, huecos, docentes preferidos y carga objetivo. “No sé qué elegir” produce tres
planes nombrados: equilibrado, compacto y avance máximo.

El Course Catalog se vuelve una ficha rica: descripción, créditos, componentes,
historial personal, requisito que satisface, secciones del término y posibilidad de
agregar al plan. Course Requirement Alerts aparecen dentro de la materia afectada, no en
un módulo separado.

### 5.4 Inscripción — preparación, ejecución y reconciliación

La pantalla usa cuatro estados maestros: Preparando, Listo, En vivo y Resultado. Integra
ventana de inscripción, carrito, validaciones propias, holds, choques, cupos, requisitos,
formalización y receipt final.

Capacidades:

- View My Classes, Shopping Cart, Class Search and Enroll y Enroll by Requirements se
  convierten en un único flujo;
- Add, Drop, Edit y Swap usan la misma selección visual de secciones. Drop y Swap exigen
  resumen y confirmación; Edit solo aparece si la cuenta está autorizada;
- el estado “not authorized” se explica y nunca se presenta como “no hay opciones”;
- Enrollment Dates muestra la fecha oficial y dice “hora no publicada” si el portal no
  ofrece hora;
- el carrito se compara con el plan y el horario real para detectar pérdida silenciosa
  de secciones;
- Formalizar Inscripción aparece como paso final cuando el componente lo permita. Es una
  acción nativa protegida, manual, nunca parte del watcher;
- el resultado se reconcilia contra View My Classes y guarda un recibo materia por
  materia;
- hitos o milestones relevantes aparecen en la timeline del ciclo.

Update, Swap, Planner y Enroll by Requirements pueden ser visibles pero no autorizados.
Mikampus registra capacidad por usuario/término y adapta la UI; no promete controles que
la universidad no habilitó.

### 5.5 Carrera — una sola verdad académica

Unifica Academic Progress, Academic Records, créditos transferidos y la trayectoria ya
construida. Sus tabs son Resumen, Pénsum, Historial, Índice y Graduación.

**Resumen** muestra créditos completados/en curso/pendientes, índice, ritmo, término
esperado de graduación, alertas y asesor. **Pénsum** conserva el árbol real de requisitos,
electivas y estados. **Historial** incluye taken, transferred, in progress y planned,
permite filtrar por término/estado y abre la ficha de materia. **Índice** conserva el
what-if local, metas y señales. **Graduación** convierte el estado en una checklist:
requisitos, hitos, término esperado, solicitud, estado y documentos.

Innovaciones:

- **Ruta crítica de graduación.** Detecta cadenas de requisitos que pueden atrasar más
  de un ciclo cuando los prerequisitos oficiales estén disponibles.
- **Escenarios de graduación.** “Con 15 créditos por ciclo”, “sin verano” o “con dos
  veranos”; cada fecha explica sus supuestos.
- **Auditoría de créditos transferidos.** Separa Course, Test y Other Credits; muestra
  curso equivalente, unidades, estado y qué requisito del pénsum cubre. Señala créditos
  aprobados que no parecen aplicados a ningún requisito para revisión humana.
- **Expediente legible.** El transcript no oficial se presenta como historial navegable
  y permite exportar un PDF claramente marcado “no oficial”. La solicitud oficial sigue
  un handoff guiado.
- **Asesoría preparada.** Antes de una reunión, genera un resumen local con progreso,
  preguntas, alertas, plan tentativo y notas de advising. Nunca envía nada solo.

### 5.6 Finanzas — entender antes de pagar

MiCampus separa balance, cargos, pagos, estimación, ayuda y planes. Mikampus los convierte
en una historia financiera con tres tabs: Ahora, Próximo ciclo e Historial.

**Ahora** muestra balance, cargos por vencer, aid pendiente y la explicación por
concepto. **Próximo ciclo** ejecuta la Estimación de costo en modo lectura y deja simular
carga de créditos, carrera, programa, plan, moneda y campus. **Historial** relaciona pagos
con cargos y permite buscar por fecha, concepto o monto.

Innovaciones:

- “¿Por qué debo esto?” descompone el balance y resalta cargos nuevos desde el último
  sync;
- calendario de vencimientos con recordatorios configurables;
- comparación de escenarios de 12/15/18 créditos sin realizar ninguna inscripción;
- costo restante estimado de la carrera, con rango y supuestos explícitos;
- conciliación simple: cargo, pago aplicado, ayuda pendiente y saldo;
- recibos y 1098-T reunidos en Documentos;
- Payment Plan, Make a Payment, Miscellaneous Items y Direct Deposit son handoffs
  guiados. Mikampus abre la ruta exacta, no toca monto, cuenta bancaria ni Submit;
- Student Permissions se explica en lenguaje común y se enlaza a su detalle.

Financial Aid tiene estados honestos. Si la cuenta no tiene award grid, se muestra el
mensaje institucional y “sin datos disponibles”, no “RD$0”. Cuando haya datos reales,
se modelan ofertas, aceptado, desembolsado, pendiente y requisitos faltantes antes de
diseñar automatización.

### 5.7 Bandeja — todo lo que la universidad espera de ti

Unifica To Do List, Holds, Mensajes PUCMM, Completed Agreements, notificaciones de
Mikampus y recordatorios de evaluación. Filtros: Todo, Requiere acción, Académico,
Finanzas, Inscripción y Leído.

Los mensajes se sincronizan primero como metadata: título, estado y fecha. Como abrir un
mensaje puede marcarlo leído, el detalle se abre únicamente por acción explícita y la UI
advierte “al abrirlo, MiCampus puede marcarlo como leído”. El cuerpo se cifra en cache o
no se persiste, según la política de datos final.

Un hold vacío o placeholder se confirma contra Student Center antes de alertar. Los
acuerdos completados se presentan como evidencia, no como tareas. Si el componente no
está autorizado, el Sync Center conserva ese estado.

### 5.8 Trámites y documentos — un catálogo orientado a intención

`/tramites` evita el árbol Classic. El estudiante busca “constancia”, “graduación”,
“récord”, “cambiar teléfono” o “evaluar profesor” y recibe una ficha con requisitos,
tiempo estimado, costo si se conoce, datos que necesitará, acción y estado posterior.

Trámites iniciales:

- transcript no oficial: vista y exportación local marcada;
- transcript oficial: handoff guiado y seguimiento de estado cuando esté disponible;
- enrollment verification: solicitud guiada y acceso a resultados;
- apply for graduation y graduation status: checklist + handoff + verificación;
- Historia Académica Estudiante: ejecución batch solo bajo acción explícita, con run
  control aislado y seguimiento del reporte; nunca durante un sync;
- evaluación profesoral: formulario accesible que conserva borrador local, pero no
  sugiere respuestas. Submit/Rechazar requieren confirmación final y recibo;
- formalización de inscripción: también visible desde Inscripción;
- 1098-T, recibos, permisos, acuerdos y reportes producidos: biblioteca documental;
- Advising Notes, Assignments y Milestones: consulta nativa cuando la cuenta publique
  contenido; si no, estado vacío/no autorizado verificable.

Los documentos guardados indican fuente, fecha de generación, vigencia y si son
oficiales. Un PDF generado por Mikampus nunca usa el sello ni se presenta como documento
oficial de PUCMM.

### 5.9 Perfil — datos, privacidad y preferencias

Perfil reúne Personal Details, Contact Details, Addresses, Emergency Contacts,
Ethnicity, Privacy Restrictions y las entradas Classic: nombres, teléfonos, email,
internet, idiomas, licencias, membresías, experiencia, extracurriculares, honores,
publicaciones, preferencias y demografía.

La pantalla abre en modo lectura y agrupa por propósito, no por tablas. Los campos
editables usan diff (“antes → después”), reautenticación y confirmación. Datos altamente
sensibles como etnicidad, restricciones FERPA, contacto de emergencia y cuenta bancaria
no se cachean por defecto. “Descargar mis datos” y “Borrar datos locales” explican
exactamente qué se borra y qué sigue existiendo en PUCMM.

Las preferencias de Mikampus viven separadas de las de PUCMM: tema, notificaciones,
antelación de clase, calendario, campus y privacidad. Nunca se sobrescribe una
preferencia institucional por cambiar una preferencia local.

### 5.10 Recursos — el ecosistema PUCMM sin perder contexto

Biblioteca, PVA/Moodle, Publicaciones y recuperación de contraseña aparecen como
recursos verificados, con dominio de destino visible. Cuando sea útil, el link lleva
contexto local sin incluir PII: desde una materia se puede abrir PVA; desde investigación,
Biblioteca; desde Cuenta, recuperación de contraseña.

Reporting Tools, PeopleTools y carpetas administrativas no se muestran como funciones
estudiantiles. Sí aparecen en `/ajustes/compatibilidad` como rutas descubiertas,
clasificadas “sistema, sin intención estudiantil”, para que la cobertura del mapa sea
auditable y no parezca un olvido.

## 6. Modelo de datos e integración

El patrón actual de GET cacheado + POST de sync explícito se mantiene. Todo módulo nuevo
tiene recon sanitizado, parser puro, esquema Zod, tablas con `user_id`, repositorio de
lectura/escritura, endpoints, UI, fixtures y prueba de estados. La fuente preferida sigue
la jerarquía de `MAPA-MICAMPUS.md:536-550`.

Tablas nuevas propuestas:

| Tabla | Guarda |
|---|---|
| `attention_items` | bandeja normalizada, prioridad, deadline, source y estado |
| `sync_sources` | disponibilidad, último éxito/error, término y capacidad |
| `attendance_courses` / `attendance_events` | resumen y fechas/horas oficiales |
| `todos` / `messages` / `agreements` | bandeja institucional sin mezclar conceptos |
| `account_charges` / `payments` / `aid_awards` | snapshot financiero de lectura |
| `cost_estimates` | escenarios y supuestos, nunca instrucciones de pago |
| `transfer_credits` | Course/Test/Other y equivalencias |
| `advisors` / `academic_alerts` / `milestones` | apoyo y señales oficiales |
| `documents` / `service_requests` | metadata, archivo cifrado opcional y seguimiento |
| `profile_sections` | allowlist mínima de datos cacheables |
| `action_receipts` | evidencia sanitizada de mutaciones iniciadas por el usuario |
| `notification_preferences` | canal y frecuencia por categoría |
| `personal_events` | recordatorios añadidos por el estudiante |

No se construye un scraper universal de PeopleSoft. Cada adaptador tiene allowlist de
acciones. El cliente nunca manda un `ICAction` arbitrario. Los formularios conservan el
estado oculto solo en memoria durante la operación y descartan `ICSID` al terminar.

## 7. Privacidad, seguridad y honestidad

- Datos académicos, financieros, de perfil y mensajes son privados por usuario desde la
  primera migración; ninguna tabla nueva nace sin `user_id`.
- El cache financiero y documental se cifra en reposo antes de un lanzamiento
  multiusuario. Los cuerpos de mensajes y documentos son opt-in.
- Nunca entran a fixtures EMPLID, CLASS_NBR observado, nombres, docentes asociados al
  horario personal, notas, montos, cuerpos, direcciones, cookies o tokens.
- Pagos, depósito directo y aceptación de ayuda quedan fuera de la automatización.
- Evaluaciones no reciben contenido generado ni recomendaciones de respuesta.
- Toda proyección dice “estimación” y enseña supuestos; GPA, costo, asistencia y fecha de
  graduación oficiales se distinguen visualmente de cálculos locales.
- Una ruta visible pero no autorizada es un estado de compatibilidad, no un error del
  estudiante.
- Las acciones protegidas requieren sesión fresca, preview final y confirmación. No se
  reintentan automáticamente si el resultado es ambiguo; primero se reconcilian.

## 8. Matriz exhaustiva de paridad con MAPA-MICAMPUS.md

Esta tabla es el contrato de cobertura. “Ahora” describe lo que ya existe en el repo;
“Destino” define cuándo la intención queda resuelta.

| Capacidad del mapa | Implementación Mikampus | Modalidad | Ahora |
|---|---|---|---|
| Homepage Fluid | Inicio orientado a atención; no se replica el mosaico | Nativa | Parcial |
| Academic Progress Summary | Resumen de Carrera | Nativa | Parcial |
| Academic Progress detallado | Pénsum real y trayectoria | Nativa | Hecho |
| Course Requirement Alerts | Alertas en Carrera, Planear y Bandeja | Nativa | Pendiente |
| Expected Graduation Term | Escenarios y fecha oficial en Graduación | Nativa | Pendiente |
| Advisors | ficha, contacto y preparación de asesoría | Nativa | Pendiente |
| Refresh de Academic Progress | Sync explícito con progreso visible | Interna + visible | Hecho parcial |
| Course History | Historial filtrable y ficha de materia | Nativa | Hecho parcial |
| View Grades | notas, índice, cambios y metas | Nativa | Hecho |
| Unofficial Transcript | expediente legible + PDF no oficial | Nativa | Pendiente |
| Request Official Transcript | trámite preparado y seguimiento | Handoff | Pendiente |
| Account Balance | balance explicado en Finanzas | Nativa | Pendiente |
| Make a Payment | resumen + apertura exacta + verificación al volver | Handoff | Pendiente |
| Charges Due | cargos, conceptos y vencimientos | Nativa | Pendiente |
| Direct Deposit | checklist y apertura exacta sin cache bancario | Handoff | Pendiente |
| Payment History | timeline conciliada | Nativa | Pendiente |
| Detalle de pago | recibo y aplicación del pago en la timeline | Nativa | Pendiente |
| Account Services | catálogo contextual de servicios financieros | Nativa | Pendiente |
| View 1098-T | biblioteca documental | Handoff | Pendiente |
| Enroll in Payment Plan | simulación informativa + apertura exacta | Handoff | Pendiente |
| Purchase Miscellaneous Items | catálogo/contexto y apertura exacta | Handoff | Pendiente |
| View Student Permissions | explicación y detalle | Nativa | Pendiente |
| Account Profile/Bank Summary | estado mínimo y acceso seguro; sin cache bancario | Handoff | Pendiente |
| Financial Aid | estado, awards, pendientes y fechas | Nativa | Pendiente de recon con datos |
| View My Classes | Hoy/horario por término | Nativa | Hecho |
| Shopping Cart | sala de control de Inscripción | Nativa | Hecho |
| Class Search and Enroll | búsqueda/plan/sección/inscripción unificadas | Nativa | Hecho parcial |
| Drop Classes | baja con doble confirmación y recibo | Nativa protegida | Hecho parcial |
| Update Classes | edición contextual si la cuenta tiene permiso | Nativa protegida | Pendiente/no autorizado observado |
| Swap Classes | preview de horario + swap atómico | Nativa protegida | Pendiente/no autorizado observado |
| Browse Course Catalog | ficha y búsqueda global | Nativa | Hecho parcial |
| Planner de PeopleSoft | Planear propio, más útil | Nativa | Reemplazado |
| Enroll by My Requirements | requisitos elegibles → inscripción | Nativa | Parcial/no autorizado observado |
| Horario actual | Semana/Día/Materias | Nativa | Hecho |
| Horarios pasados | histórico por ciclo | Nativa | Pendiente |
| Enrollment Appointments/List | ventana, estado y recibos | Nativa | Parcial |
| Change Term | selector común de ciclo y adaptación de fuente | Interna + visible | Hecho |
| Add/Edit/Swap/Grades Classic | acciones en contexto, no menú genérico | Mixta | Parcial |
| Academic Planner/Requirements | Planear + Carrera | Nativa | Hecho parcial |
| Advising Notes | ficha de asesoría | Nativa | Pendiente |
| Apply for Graduation | checklist y handoff | Handoff | Pendiente |
| Graduation Status | estado confirmado en Carrera y Trámites | Nativa | Pendiente |
| Assignments | materia/Bandeja cuando la fuente tenga contenido | Nativa | Pendiente de recon |
| Enrollment Verification | trámite y documentos | Handoff | Pendiente |
| Transfer Credit Report | auditoría de créditos y aplicación al pénsum | Nativa | Pendiente |
| Milestones | timeline de Carrera y Bandeja | Nativa | Pendiente |
| Account Activity/Payments/Pending Aid | Finanzas unificada | Mixta | Pendiente |
| Personal Details | Perfil legible | Nativa | Solo carrera/cohorte hoy |
| Demographic Data/Summary | Perfil con cache mínimo y opt-in | Nativa | Pendiente |
| Contact Details | lectura y edición con diff | Nativa protegida | Pendiente |
| Addresses | lectura y edición con diff | Nativa protegida | Pendiente |
| Emergency Contacts | lectura opt-in y edición protegida | Nativa protegida | Pendiente |
| Ethnicity | lectura opt-in; enlace protegido para cambios | Handoff | Pendiente |
| Privacy Restrictions/FERPA | explicación, estado y handoff | Handoff | Pendiente |
| Nombres/teléfonos/email/internet | Perfil por propósito | Mixta | Pendiente |
| Idiomas/licencias/membresías | Perfil académico/profesional | Mixta | Pendiente |
| Work Experience/extracurriculares | Perfil académico/profesional | Mixta | Pendiente |
| Honors/publications | logros en Perfil y Carrera | Nativa | Pendiente |
| User/Communication/Notification Preferences | Perfil y preferencias separadas | Mixta | Pendiente |
| To Do List | Bandeja priorizada | Nativa | Se scrapea, no se persiste |
| Holds | Bandeja + bloqueo en Inscripción | Nativa | Hecho parcial |
| Completed Agreements | evidencia en Bandeja/Documentos | Nativa | Pendiente/no autorizado observado |
| Notifications Center | Bandeja como destino único | Reemplazado | Pendiente |
| Student Center | desaparece como destino; sus intenciones viven arriba | Reemplazado | Parcial |
| Reporting Tools/PeopleTools | compatibilidad auditada, sin UI estudiantil | Referencia | Pendiente |
| Carpeta PE Student sin componentes | estado no autorizado en Compatibilidad | Referencia | Pendiente |
| Biblioteca | hub de Recursos y links contextuales | Referencia | Pendiente |
| PVA/Moodle | link desde materia y Recursos | Referencia | Pendiente |
| Publicaciones | Recursos y Perfil | Referencia | Pendiente |
| Recuperar contraseña | Cuenta/Recursos | Referencia | Pendiente |
| Asistencia lista/detalle | presupuesto de ausencias por materia | Nativa | Pendiente |
| Estimación de costo | simulador de próximo ciclo | Nativa | Pendiente |
| Estimación de índice | simulador local con contraste oficial | Nativa | Hecho y mejorado |
| Mensajes | Bandeja con semántica de leído | Nativa | Pendiente |
| Formalizar Inscripción | paso final manual y reconciliado | Nativa protegida | Pendiente |
| Evaluación Profesoral | formulario accesible, borrador y submit manual | Nativa protegida | Pendiente |
| Rechazar evaluación | acción manual explicada, confirmada y con recibo | Nativa protegida | Pendiente |
| Historia Académica Estudiante | job explícito + seguimiento de reporte | Nativa protegida | Pendiente |
| Course/Test/Other Transfer Credits | detalle y aplicación a requisitos | Nativa | Pendiente |
| Componentes visibles no autorizados | estado en Sync Center/Compatibilidad | Nativa | Pendiente |
| Estados de sesión/contexto/paginación | motor de sync honesto | Interna + visible | Parcial |
| Navigation collections y shell | adaptadores internos; nunca visibles | Interna | Parcial |

## 9. Orden de implementación

Cada fase vive en su propia rama desde `dev`, tiene recon antes de scraper y no se cierra
solo porque la pantalla se vea bien. El gate es datos reales sanitizados, estados de
error, responsive, accesibilidad, tests y matriz de paridad actualizada.

### Fase 11 — Plataforma de fuentes y atención

Construir `sync_sources`, estados tipados, Sync Center, `attention_items`, preferencias
de notificación y recibos de acciones. Persistir to-dos por separado de holds. Cambiar el
Dashboard al briefing priorizado sin romper las rutas actuales.

**Criterio de salida:** cada fuente existente puede decir último éxito, freshness y
estado; un error conserva el snapshot anterior; Inicio muestra solo información que
requiere atención.

### Fase 12 — Hoy y asistencia

Recon y parser de `PUC_CONS_ASIS_EST` + detalle, tablas, endpoints, tests y `/hoy` con
Día/Semana/Materias. Añadir presupuesto de ausencias, alertas configurables, cambios de
horario y horarios pasados.

**Criterio de salida:** todas las filas y fechas se extraen con View All; la proyección
distingue claramente horas oficiales de clases estimadas; un estudiante puede pasar una
semana usando `/hoy` sin abrir MiCampus.

### Fase 13 — Bandeja completa

Integrar To Do, Mensajes, Holds, Agreements, alertas académicas, evaluaciones pendientes
y milestones. Implementar apertura explícita de mensajes y confirmación contra Student
Center para placeholders.

**Criterio de salida:** Bandeja conserva fuente, leído, deadline, severidad y acción; abrir
un mensaje es la única operación que puede cambiar su estado.

### Fase 14 — Finanzas y ayuda

Recon seguro de balance, cargos, historial, permisos, estimación de costo y Financial
Aid con una cuenta que tenga datos o fixtures sintéticos autorizados. Construir
Finanzas, comparación de escenarios, vencimientos y handoffs de pago.

**Criterio de salida:** ninguna ausencia de datos se muestra como cero; ningún test ni
scraper presiona controles de pago o depósito; todos los montos indican moneda y fecha.

### Fase 15 — Carrera y documentos

Créditos transferidos, expected graduation term, advisors, alerts, milestones,
transcript no oficial, enrollment verification, graduación y job de Historia Académica.
Completar el módulo de documentos pendiente de `PLAN.md:275-282`.

**Criterio de salida:** Carrera explica cada crédito y requisito; todo documento indica
si es oficial; los procesos batch solo corren por acción explícita y tienen seguimiento.

### Fase 16 — Perfil y privacidad

Recon por subsección, política de minimización, lectura agrupada, edición con diff y
handoffs FERPA/etnicidad. Añadir exportación y borrado de cache personal.

**Criterio de salida:** los campos sensibles no se cachean por defecto; ninguna edición
puede enviarse sin reautenticación y preview; cambiar de cuenta limpia todos los datos
personales del usuario anterior.

### Fase 17 — Flujos protegidos y trámites

Swap/Update cuando estén autorizados, formalización, evaluación, solicitudes y action
receipts. Construir el catálogo de trámites y la verificación al volver de un handoff.

**Criterio de salida:** cada mutación tiene allowlist, prueba del preview, confirmación,
resultado ambiguo seguro y reconciliación; no existe retry automático de Submit.

### Fase 18 — Paridad certificada y consolidación

Nueva navegación, redirects, búsqueda global extendida, Recursos y
`/ajustes/compatibilidad`. Ejecutar la matriz completa con cuentas/estados distintos,
documentar lo no autorizado y retirar rutas duplicadas solo después de equivalencia.

**Criterio de salida:** las filas de la matriz están Hecho, Reemplazado, Handoff probado
o No autorizado verificado; ninguna está simplemente Pendiente. Un estudiante piloto
completa un ciclo académico normal sin navegar el árbol de MiCampus.

## 10. Ideas que convierten paridad en ventaja

Estas funciones no existen como pantalla en MiCampus, pero nacen de combinar sus datos:

- **Pulso semanal:** cada domingo resume asistencia, entregas/tareas disponibles,
  cambios, notas, balance y próxima semana en menos de un minuto.
- **Modo “voy tarde”:** desde el móvil muestra solo próxima clase, aula, mapa/link y
  acceso a la materia; todo lo demás desaparece temporalmente.
- **Ensayo de decisiones:** faltar a una clase, retirar una materia, sacar una nota,
  tomar 12/15/18 créditos o no cursar verano actualiza consecuencias sin tocar datos
  oficiales.
- **Detector de bloqueo futuro:** cruza holds, requisitos, pagos, evaluaciones y ventana
  para avisar días antes de una inscripción, no cuando el carrito falla.
- **Plan B automático:** cada sección del plan puede tener reemplazo compatible. Si
  cierra, Mikampus muestra la siguiente combinación sin choque; nunca la inscribe sin
  consentimiento.
- **Memoria académica personal:** al terminar un ciclo, archiva horario, resultados,
  asistencia y notas personales en una cápsula navegable.
- **Preparar conversación:** genera una agenda para asesoría o coordinación con hechos y
  preguntas del estudiante, no diagnósticos automáticos.
- **Explicador de universidad:** traduce hold, aid, permission, transferred, planned,
  waitlist y cada estado institucional a español concreto, con la fuente al lado.
- **Estado offline:** horario, contactos de emergencia elegidos, documentos opt-in y
  agenda del día siguen disponibles sin red; acciones y datos sensibles requieren red.
- **Accesibilidad real:** modo de alta legibilidad, navegación completa por teclado,
  lecturas de tabla correctas y evaluación profesoral utilizable sin el formulario
  Classic.

## 11. Métricas de éxito

La plataforma no se mide por cantidad de módulos. Se mide por dependencia eliminada y
decisiones resueltas:

| Métrica | Objetivo de piloto |
|---|---:|
| Días activos semanales durante docencia | ≥ 4 |
| Aperturas de MiCampus iniciadas manualmente | < 1 por semana |
| Estudiantes que consultan Hoy antes de una clase | ≥ 60% semanal |
| Holds/tareas vistos antes del deadline | ≥ 90% |
| Inscripciones con carrito preparado antes de la ventana | ≥ 90% |
| Alertas de asistencia útiles, no silenciadas | ≥ 70% |
| Operaciones ambiguas sin reconciliación | 0 |
| Pagos o evaluaciones iniciados automáticamente | 0 |
| Filas de paridad sin disposición explícita | 0 |

La prueba final es sencilla: durante un ciclo completo, el estudiante solo entra a una
pantalla original de MiCampus cuando Mikampus lo lleva allí deliberadamente para una
confirmación sensible. Nunca porque no sabía dónde encontrar algo.
