# Mapa técnico completo de la PVA PUCMM (Moodle)

> Reconstruido con el servicio de web services `moodle_mobile_app` contra
> `campusvirtual.pucmm.edu.do/moodle` el 2026-09-07, con un token de estudiante
> obtenido por `login/token.php`. La evidencia son 32 volcados JSON de solo
> lectura más un puñado de peticiones HTTP en vivo contra `pluginfile.php` y
> `core_course_get_updates_since`. El propósito de este documento es describir
> el protocolo, las formas de respuesta y las trampas necesarias para escribir
> el cliente. No contiene datos del estudiante observado.

Instancia: Moodle **5.1.5 (Build: 20260608)**, `version` **2025100605**, tema
`remui`, idioma `es_mx`, calendario gregoriano, **438 funciones** expuestas al
servicio móvil, montado en la **subruta `/moodle`**.

## Alcance y reglas de privacidad

Este mapa guarda estructura, no contenido. Nunca deben entrar al repositorio ni
a un fixture: nombres, matrícula, `userid` real, ids de curso o de tarea
observados, nombres de materias, calificaciones, mensajes, nombres de
profesores, ni ninguna credencial. En fixtures se reemplazan por valores
sintéticos conservando la forma exacta del JSON, incluidas las claves ausentes.

| Valor | Sustitución recomendada |
|---|---|
| `wstoken` | eliminar por completo |
| `userprivateaccesskey` (32 alfanuméricos) | eliminar por completo |
| `sesskey` dentro de `editurl` / `deleteurl` | eliminar por completo |
| `userid`, `useridfrom`, `useridto` | `{USERID}` |
| `username`, `firstname`, `lastname`, `fullname`, `useridnumber` | valores sintéticos |
| `courseid`, `course.fullname`, `shortname`, `idnumber` | `{COURSEID}`, nombres sintéticos |
| `cmid`, `instance`, `assign.id`, `gradeitem.id` | ids sintéticos coherentes entre sí |
| `graderaw`, `gradeformatted`, `rawgrade`, `feedback.grade.grade` | valores sintéticos |
| `contents[].author`, `contents[].userid` | eliminar (son profesores reales) |
| `filename`, `activityname`, `itemname` | nombres sintéticos |
| `messages[].text`, `fullmessage`, `subject` | texto sintético |
| `course.courseimage` (data URI base64) | eliminar; es el 75% del peso y no aporta |

Tres campos de la respuesta son **credenciales disfrazadas de dato** y hay que
tratarlos como tales:

| Campo | Qué da | Dónde vive |
|---|---|---|
| `wstoken` (de `login/token.php`) | todo el API a nombre del estudiante | credentialStore, modo 600 |
| `site_info.userprivateaccesskey` | calendario y `tokenpluginfile.php` **sin sesión** | credentialStore, junto al token |
| `sesskey` (dentro de `editurl`) | CSRF de la sesión web | nunca se persiste, además rota |

Serializar la respuesta completa de `core_webservice_get_site_info` a un log, a
un fixture o a la base filtra `userprivateaccesskey`. Es el error más fácil de
cometer de todo el dominio.

## Modelo de la plataforma

Todo cuelga de `site_info.siteurl`, que **incluye la subruta**. Armar endpoints
desde el host y no desde `siteurl` rompe todo.

```text
SITEURL = https://campusvirtual.pucmm.edu.do/moodle
```

| Endpoint | Uso |
|---|---|
| `{SITEURL}/login/token.php` | usuario + contraseña + `service=moodle_mobile_app` → `wstoken` |
| `{SITEURL}/webservice/rest/server.php` | todas las `wsfunction`, POST form-urlencoded, `moodlewsrestformat=json` |
| `{SITEURL}/webservice/pluginfile.php/...` | descarga de archivos, con `&token=` o `?token=` |
| `{SITEURL}/tokenpluginfile.php/{userprivateaccesskey}/...` | misma descarga sin token en la query |
| `{SITEURL}/webservice/upload.php` | subida multipart (no es una `wsfunction`) |

### El sobre y los errores

`core_*` no tiene un sobre único. En el volcado conviven tres formas:

| Forma | Funciones que la usan |
|---|---|
| objeto con `warnings[]` | 17 de las 21 respuestas-objeto (`mod_assign_get_assignments`, `gradereport_*`, `core_completion_*`, `core_course_get_updates_since`, ...) |
| objeto **sin** `warnings` | `core_calendar_get_action_events_by_timesort` (`{events, firstid, lastid}`), `core_message_get_conversations`, `message_popup_get_popup_notifications`, `core_webservice_get_site_info` |
| arreglo pelado | `core_course_get_contents`, `core_enrol_get_users_courses`, `mod_forum_get_forums_by_courses` |

Un desempaquetador genérico único no cubre las tres.

**Los errores llegan con HTTP 200.** El cuerpo trae `errorcode` y no hay status
que mirar. Un cliente que decida por `res.ok` trata cada excepción como éxito y
guarda basura. Único `errorcode` registrado en el volcado:
`nopermissiontoviewgrades`. Que el sobre traiga además `exception`, `message` y
`debuginfo` es supuesto (memoria del protocolo y del código cliente).

Además hay tres formas distintas de recibir un 200 con basura al bajar un
archivo, verificadas en vivo:

| Petición | Respuesta real |
|---|---|
| `pluginfile.php?...&wstoken=<token>` | **200** `application/json` con `errorcode: 'missingparam'` (el parámetro se llama `token`, no `wstoken`) |
| `pluginfile.php?...` sin token | **200** `application/json` con el mismo error |
| `/pluginfile.php/...` sin el prefijo `/webservice/` | **303** hacia el login; con `curl -L` termina en 200 de HTML |

La defensa es validar `Content-Type` antes de escribir el archivo a disco.

### Convenciones de tipos que hay que asumir

| Convención | Detalle |
|---|---|
| `0` como centinela de fecha | `duedate`, `cutoffdate`, `allowsubmissionsfromdate`, `gradingduedate`, `timecompleted`, `extensionduedate`. `0` no es 1970: es "no hay fecha". Normalizar a `NULL` al escribir |
| cadena vacía ≠ ausente ≠ `null` | 12 de los 62 settings llegan como `""`; `mimetype` e `isexternalfile` llegan como **clave ausente** en 53 de 96 contents; `feedback` llega como **clave ausente** cuando no hay nota |
| booleanos mixtos en un mismo objeto | `usercanmanageownfiles` y `userissiteadmin` son booleanos JSON; `downloadfiles`, `uploadfiles` y `policyagreed` son `0/1`. No hay regla, hay que ir campo por campo |
| tri-estado | `locked`, `gradeislocked`, `gradeisoverridden` llegan `null`, nunca `false`, mientras `gradeishidden` y `gradeneedsupdate` sí llegan booleanos |
| listas `{name, value}` | `functions`, `advancedfeatures`, `settings`, `configs`. El orden no es contrato: indexar por nombre |
| tipos que cambian por función | `settings[].value` es `string \| number` (`numsections` llega `1`, sin comillas); `customdata.duedate` es `int` en `assign` y `string` en `forum` |
| JSON dentro de un string | `modules[].customdata` y `notifications[].customdata`. Hay que `parse` **y** verificar que dio un objeto |
| PHP serializado dentro de ese JSON | `customdata.displayoptions` llega como `a:1:{s:10:"printintro";i:1;}` en los 38 `resource`. No es JSON |
| epoch en **segundos** | Moodle no usa milisegundos en ningún campo del volcado |

### Idioma, zona horaria y semana

| Ajuste | Valor | Consecuencia |
|---|---|---|
| `lang` del usuario | `es_mx` | todo string traducible llega en español; nunca es constante de protocolo |
| `course.lang` | `es`, `es_mx`, `en` y `""` conviven | `dates[].label` y `modplural` llegan **mezclados en idiomas dentro de la misma respuesta** |
| `timezone` / `forcetimezone` | `America/Santo_Domingo` (impuesta al sitio) | todo epoch se renderiza en esa zona, no en la del dispositivo |
| `calendar_startwday` | `1` | la semana arranca lunes |
| `sitecalendartype` / `usercalendartype` | `gregorian` | si difieren, manda el del usuario |

Una entrega de las 11:59 pm local es 03:59 UTC del día siguiente. Agrupar por
día con `date(timesort,'unixepoch')` corre las entregas un día hacia adelante.

Identificadores estables (comparables como constantes): `modname`, `status`,
`gradingstatus`, `eventtype`, `component`, `dataid`, `itemtype`, `type`,
`errorcode`. Todo lo demás que se lea es copy.

### Concurrencia

`limitconcurrentlogins` vale **1**. El sitio permite una sesión concurrente por
usuario. Un sync paralelo, o un sync mientras el estudiante tiene la PVA abierta
en el navegador, puede tumbar una de las dos. El diseño obligado: un solo
trabajador por usuario, llamadas en serie, y agrupar el fan-out con
`tool_mobile_call_external_functions`, que está expuesta y empaqueta N llamadas
en un solo POST.

`tool_mobile_get_autologin_key` existe para abrir la PVA ya logueada en el
navegador, pero tiene su propio límite de 360 s entre llamadas
(`tool_mobile_autologinmintimebetweenreq`).

## Identidad y catálogo de funciones

Dos llamadas: `core_webservice_get_site_info()` y `tool_mobile_get_config()`.
Este dominio es la raíz de todo: `userid` sale de acá y es parámetro obligatorio
del resto, y `siteurl` arma cada endpoint.

### `core_webservice_get_site_info`

29 claves de primer nivel.

| Campo | Tipo | Significado |
|---|---|---|
| `sitename` | string | nombre público; coincide con `settings[name=fullname]` |
| `username` | string | el login del portal. En el volcado son 8 caracteres y **no todos dígitos**: no asumir matrícula numérica |
| `firstname` / `lastname` | string | nombre y apellidos |
| `fullname` | string | lo arma Moodle según `fullnamedisplay`; no es `firstname + ' ' + lastname` garantizado |
| `userid` | int | id interno; parámetro obligatorio de casi todo el resto |
| `siteurl` | string | base absoluta **con subruta** |
| `siteid` | int | `courseid` del front page (`1`) |
| `lang` | string | `es_mx` |
| `theme` | string | `remui` (Edwiser RemUI), **no Boost**: cualquier fallback que raspe HTML escrito contra Boost no aplica |
| `release` | string | `5.1.5 (Build: 20260608)`. Texto libre, solo para mostrar |
| `version` | string | `2025100605`. Único campo comparable (como entero) para detectar upgrade |
| `userpictureurl` | string | placeholder del tema (`/theme/image.php/<tema>/core/<rev>/u/f1`) cuando no hay foto; pasa a `pluginfile.php` cuando sí la hay |
| `mobilecssurl` | string | cadena vacía, no `null` |
| `functions[]` | array(438) de `{name, version}` | catálogo del **servicio** para **ese** token |
| `advancedfeatures[]` | array(12) de `{name, value}` | interruptores globales del sitio |
| `downloadfiles` / `uploadfiles` | 0/1 | ambos `1` |
| `usercanmanageownfiles` | boolean | `true` (booleano JSON, a diferencia de los dos anteriores) |
| `userquota` | int (bytes) | `104857600` (100 MB), cuota **total** de archivos privados |
| `usermaxuploadfilesize` | int (bytes) | `524288000` (500 MB), máximo **por archivo** |
| `userhomepage` | int (enum) | `1`. El enum completo no está evidenciado |
| `userprivateaccesskey` | string(32) | **credencial** (ver privacidad) |
| `userissiteadmin` | boolean | `false` |
| `policyagreed` | 0/1 | `0`, inofensivo porque `sitepolicy` está vacío |
| `limitconcurrentlogins` | int | `1` |
| `usersessionscount` | int | `1` |
| `sitecalendartype` / `usercalendartype` | string | `gregorian` |

`advancedfeatures`, los 12 y sus valores observados:

| En `1` | En `0` |
|---|---|
| `usetags`, `enablenotes`, `messaging`, `enableblogs`, `enablecompletion`, `enablebadges`, `enablecustomreports`, `mnet_dispatcher_mode`, `enablecompetencies` | `usecomments`, `messagingallusers`, `enableglobalsearch` |

Una función puede estar en el catálogo y aun así reventar porque su feature está
apagada. Antes de una escritura hay que consultar las dos cosas: `functions`
dice que existe, `advancedfeatures` dice si el sitio la dejó viva.

### `tool_mobile_get_config`

62 settings, `warnings` vacío. La forma del elemento de `warnings` no se
observó.

| Setting | Valor | Por qué importa |
|---|---|---|
| `shortname` | `PVA` | nombre corto del sitio |
| `numsections` | `1` **como number** | el único valor no-string; revienta cualquier validador que tipe `value` como `string` |
| `timezone` / `forcetimezone` | `America/Santo_Domingo` | impuesta a todo el sitio |
| `calendar_startwday` | `'1'` | la semana arranca lunes |
| `calendar_lookahead` / `calendar_maxevents` | `'21'` / `'10'` | horizonte y tope de la vista "próximos eventos" del sitio |
| `coursegraceperiodbefore` / `coursegraceperiodafter` | `'7'` / `'7'` | un curso cuenta como "en curso" 7 días antes de empezar y 7 después de terminar |
| `tool_mobile_autologinmintimebetweenreq` | `'360'` | rate limit propio del autologin |
| `tool_mobile_forcelogout` / `autologout` / `autologouttime` | `'0'` / `'0'` / `'86400'` | ni forzado de logout ni autologout: el token vive hasta que se revoque |
| `sitepolicy` / `sitepolicyhandler` | `''` | no hay política que aceptar hoy |
| `customusermenuitems` | string | formato `etiqueta,componente\|/ruta` separado por **`\r\n`**, no `\n` |
| `mygradesurl` | URL | reporte general de notas, sirve para deep link con autologin |
| `searchengine` | `'simpledb'` | configurado, pero `enableglobalsearch=0`: las `core_search_*` están muertas |
| `disableuserimages` | `'0'` | las fotos de perfil están permitidas |
| `supportname` / `supportemail` / `supportavailability` | string | contacto real para un mensaje de error accionable |
| `core_admin_coursecolor1..10` | `#hex` | **diez claves numeradas**; buscar la clave exacta `core_admin_coursecolor` no encuentra nada |
| `tool_mobile_disabledfeatures` | `''` | la institución no apagó ninguna sección de la app móvil |

Las **12** claves que llegan como cadena vacía, no ausentes ni `null`:
`summary`, `frontpage`, `frontpageloggedin`, `sitepolicy`, `sitepolicyhandler`,
`supportpage`, `searchbanner`, `tool_mobile_customlangstrings`,
`tool_mobile_disabledfeatures`, `tool_mobile_filetypeexclusionlist`,
`tool_mobile_custommenuitems`, `tool_mobile_apppolicy`.

### El catálogo de 438 funciones

`functions` es el catálogo del **servicio** `moodle_mobile_app` para **ese**
token, no del sitio. Otro servicio o un token de otro rol devuelve otra lista.
Guardarlo global, y no por usuario, es una bomba de tiempo. 438 nombres, sin
duplicados.

Reparto por área (clasificación derivada del prefijo del nombre; Moodle no
expone una taxonomía, los bordes son decisión, no protocolo):

| Área | Funciones | Núcleo |
|---:|---:|---|
| identidad y configuración | 48 | `core_webservice_get_site_info`, `core_user_*` (16), `tool_mobile_*` (8), `tool_policy_*`, `tool_dataprivacy_*`, `message_airnotifier_*`, `core_filters_*`, `core_ai_*` |
| cursos | 51 | `core_course_*` (17), `core_enrol_*` (4), `enrol_self_/enrol_guest_` (4), `core_completion_*` (4), `core_courseformat_*` (2), `core_group_*` (6), bloques (5), `core_search_*` (4), `core_tag_*` (5) |
| tareas | 24 | todo `mod_assign_*`, incluido el bloque de corrección que es de docente |
| notas | 16 | `gradereport_user_*` (4), `gradereport_overview_*` (2), `gradereport_grader_*`, `gradereport_singleview_*`, `core_grades_*` (8) |
| calendario | 15 | todo `core_calendar_*` |
| foros | 20 | todo `mod_forum_*` |
| mensajes y avisos | 47 | `core_message_*` (41), `message_popup_*` (2), `core_notes_*` (4) |
| archivos | 4 | `core_files_get_files`, `core_files_get_unused_draft_itemid`, `core_files_delete_draft_files`, `core_h5p_get_trusted_h5p_file` |
| módulos y subsistemas no priorizados | 213 | `mod_quiz` (19), `mod_workshop` (19), `mod_glossary` (18), `mod_lesson` (17), `mod_feedback` (14), `mod_data` (11), `mod_wiki` (10), `mod_bigbluebuttonbn` (10), `mod_scorm` (9), `mod_h5pactivity` (7), `mod_choice` (6), `core_xapi` (6), `core_competency` (9), `tool_lp` (8), `core_blog` (7), `core_reportbuilder` (5), `core_badges` (3), `core_comment` (3), `core_rating` (2), `mod_lti` (3), `mod_label` (1), y `mod_book`/`mod_folder`/`mod_imscp`/`mod_page`/`mod_resource`/`mod_url` (2 cada uno) |

**75 de las 438 mutan estado.** Las que le sirven al estudiante:
`mod_assign_start_submission`, `save_submission`, `submit_for_grading`,
`remove_submission`; `mod_forum_add_discussion`, `add_discussion_post`,
`update_discussion_post`, `delete_post`; `core_calendar_create_calendar_events`
y `delete_calendar_events`; `core_message_send_instant_messages` y
`send_messages_to_conversation`; `core_course_set_favourite_courses`;
`core_user_add_user_private_files` y `core_user_update_private_files`;
`core_completion_update_activity_completion_status_manually`;
`mod_quiz_start_attempt` / `save_attempt` / `process_attempt`;
`mod_choice_submit_choice_response`.

`functions[].version` es la versión del **componente**, no del sitio. Hay 8
valores distintos entre las 438:

| Versión | Funciones | Qué es |
|---|---:|---|
| `2025100605` | 178 | core |
| `2025100601` | 151 | core |
| `2025100600` | 53 | core |
| `2025100602` | 49 | core |
| `2026080600` | 3 | `qtype_stack` (plugin de tercero, **más nuevo** que el core) |
| `2026050400` | 2 | `report_lpmonitoring` (plugin de tercero, más nuevo) |
| `2025041408` | 1 | `mod_customcert` (plugin de tercero, **más viejo**) |
| `2025040202` | 1 | `local_compextraservice_get_competencies_summary` (más viejo) |

Los cuatro ajenos al core se desvían en **las dos direcciones**, así que
comparar `functions[].version` contra `site.version` para decidir si una función
es vieja da falsos positivos en ambos sentidos.

El único `local_*` de la institución es el de competencias.

### Funciones que faltan, y lo que eso significa

| Ausente | Consecuencia |
|---|---|
| `core_files_upload` | **no existe**, y sin embargo se puede subir: la subida va por POST multipart a `webservice/upload.php`, fuera del servicio REST. Buscar la capacidad en la lista de funciones da un "no" que es mentira |
| `core_user_get_users` | buscar personas solo con `core_user_get_users_by_field` (id/idnumber/username/email exactos) o `core_enrol_search_users` (dentro de un curso). No hay búsqueda global |
| `core_grades_get_grades`, `core_grade_get_definitions` | toda nota sale por `gradereport_*`, con sus permisos por curso |
| `core_auth_request_password_reset`, `core_auth_confirm_user` | recuperar contraseña o crear cuenta no se puede desde la integración |
| `core_session_time_remaining` | no hay forma de preguntar cuánto le queda a la sesión; la única señal de token muerto es el `errorcode` de la siguiente llamada |
| `mod_attendance_*` | no hay ningún plugin de asistencia expuesto. La asistencia a clase **no sale de la PVA** |
| `local_*` institucional | solo competencias. **No hay ninguna función propia de PUCMM para horario, matrícula, pénsum, deuda ni índice académico** |

Y hay dos clases de función que están en el catálogo pero no responden, que a
efectos prácticos es lo mismo que faltar:

| Muertas por configuración | Muertas por rol |
|---|---|
| `core_search_*` (4, con `enableglobalsearch=0`), `core_comment_*` (3, con `usecomments=0`), mensajería a cualquier usuario del sitio (`messagingallusers=0`: solo contactos y compañeros de curso) | `core_enrol_get_enrolled_users`, `mod_assign_get_submissions`, `mod_assign_get_grades` sobre cursos ajenos, todo `core_grades_grader_gradingpanel_*`, `gradereport_grader_get_users_in_report` |

### `userid` no siempre se llama `userid`

| Función | Nombre del parámetro |
|---|---|
| `core_enrol_get_users_courses` | `userid` |
| `gradereport_user_get_grade_items` | `userid` |
| `gradereport_overview_get_course_grades` | `userid` |
| `core_completion_get_activities_completion_status` | `userid` |
| `core_message_get_conversations` | `userid` |
| `message_popup_get_popup_notifications` | **`useridto`** |

### Trampas del dominio

- El catálogo es **por token**, no por sitio.
- Estar en el catálogo no significa responder. Tres cosas la pueden matar: el
  feature del sitio, el rol, y **el permiso por curso**. Lo tercero está
  comprobado: `gradereport_user_get_grade_items` devolvió `ok` en dos cursos y
  `nopermissiontoviewgrades` en un tercero. Misma función, mismo token, mismo
  minuto.
- `release` es texto libre: comparar releases como string ordena `5.1.10` antes
  que `5.1.5`. La única comparación válida es `version` como entero.
- `version` (sello de octubre 2025) es **anterior** a la fecha del build
  (20260608). Son dos relojes distintos y ninguno es la fecha de instalación.
- `userquota` (100 MB total) es **menor** que `usermaxuploadfilesize` (500 MB por
  archivo). No es un rango: son dos límites independientes, y hay que chequear
  los dos. Asumir que el máximo por archivo cabe en la cuota es falso acá por un
  factor de cinco.
- `userpictureurl` apunta a un placeholder público del tema cuando no hay foto.
  Pegarle `?token=` a esa URL filtra el token a un recurso público; no pegárselo
  al avatar real devuelve 403. Hay que mirar la ruta antes de decidir. Y el
  `<rev>` de la ruta cambia con cada purga de caché, así que no sirve de clave
  de cache.
- `policyagreed=0` hoy es inofensivo, pero el día que la institución active una
  política **todas** las llamadas empiezan a fallar de golpe con
  `sitepolicynotagreed` y parece caída del sitio. Se resuelve con
  `core_user_agree_site_policy` o `tool_policy_set_acceptances_status`, ambas
  expuestas.
- Quien vea 438 funciones y asuma que la PVA reemplaza al scraping de MiCampus se
  va a estrellar.

### Esquema local

```sql
-- Una fila por usuario de mikampus: el token es de una persona y todo lo que
-- devuelve site_info lo es también. No hay historial: la fila se pisa.
CREATE TABLE IF NOT EXISTS pva_identity (
  user_id                INTEGER PRIMARY KEY,
  moodle_userid          INTEGER NOT NULL,   -- parámetro de casi todo el resto del API
  username               TEXT NOT NULL,      -- el login del portal, no necesariamente numérico
  firstname              TEXT,
  lastname               TEXT,
  fullname               TEXT,               -- lo arma Moodle; no es firstname + lastname
  siteurl                TEXT NOT NULL,      -- CON subruta; de acá cuelga cada endpoint
  siteid                 INTEGER NOT NULL,
  sitename               TEXT,
  release                TEXT NOT NULL,      -- texto libre, solo para mostrar
  version                TEXT NOT NULL,      -- sello YYYYMMDDXX, lo único comparable
  lang                   TEXT NOT NULL,
  theme                  TEXT,
  userpictureurl         TEXT,
  picture_needs_token    INTEGER NOT NULL DEFAULT 0,  -- 1 solo si la ruta es /webservice/pluginfile.php
  mobilecssurl           TEXT,               -- puede ser cadena vacía, no null
  userhomepage           INTEGER,
  downloadfiles          INTEGER NOT NULL,
  uploadfiles            INTEGER NOT NULL,
  usercanmanageownfiles  INTEGER NOT NULL,   -- llega booleano JSON, se guarda 0/1
  userquota              INTEGER,            -- bytes, cuota total
  usermaxuploadfilesize  INTEGER,            -- bytes por archivo; independiente de la cuota
  userissiteadmin        INTEGER NOT NULL DEFAULT 0,
  policyagreed           INTEGER NOT NULL DEFAULT 0,
  limitconcurrentlogins  INTEGER,            -- 1 acá: el sync no puede paralelizar
  usersessionscount      INTEGER,
  sitecalendartype       TEXT,
  usercalendartype       TEXT,
  functions_hash         TEXT NOT NULL,      -- sha256 de "name:version" ordenado: el delta del catálogo
  fetched_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
-- userprivateaccesskey NO se guarda acá a propósito: es una credencial que da
-- acceso al calendario y a tokenpluginfile.php sin sesión. Va al credentialStore
-- junto al wstoken, con el mismo modo 600, y nunca se loguea.

-- El catálogo tal como lo ve ESE token. Se consulta antes de programar
-- cualquier llamada: si el nombre no está, la rama del sync no se intenta y no
-- cuenta como error, sino como capability ausente.
CREATE TABLE IF NOT EXISTS pva_functions (
  user_id        INTEGER NOT NULL,
  name           TEXT NOT NULL,
  version        TEXT NOT NULL,              -- versión del COMPONENTE, no del sitio
  area           TEXT NOT NULL,              -- identidad|cursos|tareas|notas|calendario|foros|mensajes|archivos|modulos
  writes         INTEGER NOT NULL DEFAULT 0, -- 1 si muta estado en la plataforma
  first_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
  gone_at        TEXT,                       -- dejó de aparecer tras un upgrade del sitio
  PRIMARY KEY (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_pva_functions_area
  ON pva_functions(user_id, area) WHERE gone_at IS NULL;

-- Configuración del sitio: tool_mobile_get_config y los advancedfeatures de
-- site_info viven juntos porque se leen juntos. Sin user_id: es del sitio, no
-- de la persona. value siempre TEXT porque el WS mezcla "1" con 1.
CREATE TABLE IF NOT EXISTS pva_site_config (
  source      TEXT NOT NULL,                 -- 'mobile_config' | 'advanced_feature'
  name        TEXT NOT NULL,
  value       TEXT,                          -- cadena vacía y NULL son estados distintos
  is_numeric  INTEGER NOT NULL DEFAULT 0,    -- 1 si el JSON lo mandó sin comillas
  fetched_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source, name)
);
```

El estado del sync no necesita tabla nueva: se reusa `sync_sources`
(`src/migrations.js`, v5) con `source_key` `pva:site_info` y `pva:config`.

## Materias, secciones y módulos

Una sola llamada arma todo el árbol: `core_course_get_contents(courseid)`
devuelve un **arreglo pelado de secciones**, con sus módulos, nombres, URLs,
descripciones, fechas, archivos y estado de finalización en la misma respuesta.

Muestra: 3 cursos, 21 secciones, 131 módulos, 96 entradas de `contents`.

El prefijo `pva_` no es cosmético: el esquema de mikampus ya tiene `courses` y
`sections` con el significado de PeopleSoft (curso del catálogo, sección de un
término). Una sección de la PVA es un bloque de la página de un curso: otra
cosa, otro ciclo de vida, otra clave. Mezclarlas sería la peor decisión del
dominio.

### Sección

| Campo | Tipo | Notas |
|---|---|---|
| `id` | int | **la identidad estable**. Único en todo el sitio (21 secciones de 3 cursos, cero colisiones) |
| `section` | int | la **posición**, `0..n` contigua, `0` es la cabecera. Cambia si el profesor reordena: no es clave |
| `name` | string | nunca vino vacía; puede ser el genérico del tema o uno propio, y no hay flag que distinga |
| `summary` | string HTML | HTML crudo en 10 de 21, con `style=` inline, entidades y URLs `pluginfile.php` ya reescritas |
| `summaryformat` | int | siempre `1` (HTML) |
| `visible` / `uservisible` | 0-1 / boolean | siempre `1` / `true` |
| `hiddenbynumsections` | 0/1 | siempre `0` |
| `component` / `itemid` | null | `null` en las 21 (sección delegada a un plugin) |
| `modules[]` | array (0 a 26) | orden de página |

**10 de 21 secciones vinieron con `modules: []`, y las 10 son del mismo curso**:
un curso recién abierto, con la plantilla de temas creada y sin contenido
todavía. Ese es el caso real de "curso vacío" que la UI tiene que pintar.

Ni las secciones ni los módulos traen campo de orden. **El único orden es el del
array.** Si el parser guarda en un map y después itera, pierde cómo se ve el
curso y no hay forma de recuperarlo.

### Módulo

| Campo | Tipo | Notas |
|---|---|---|
| `id` | int | **cmid**. LA identidad entre sincronizaciones, y lo que la propia PVA pone en su URL |
| `instance` | int | id de la fila en la tabla del plugin. Salió único por sí solo en los 131, pero eso es coincidencia de un dataset chico: en Moodle cada plugin tiene su tabla, así que la clave correcta es `(modname, instance)` |
| `modname` | string enum | tipo de módulo |
| `name` | string | trae **entidades HTML sin decodificar** (4 de 131) y espacios en los bordes (1) |
| `url` | string \| **ausente** | patrón `<siteurl>/mod/<modname>/view.php?id=<cmid>`. **Ausente en los 15 `label`**, el único modname sin url |
| `description` | string HTML \| ausente | presente en 32 de 131 (15 `label`, 10 `assign`, 4 `resource`, 2 `url`, 1 `forum`), ausente en 99, **y 1 de las 32 llega vacía** |
| `contextid` | int | aparece en la ruta de los `fileurl` de pluginfile |
| `visible` / `uservisible` / `visibleoncoursepage` / `candisplay` | | todos afirmativos en el volcado |
| `noviewlink` | boolean | `true` = se renderiza en la página y no se abre. `true` **exactamente** en los 15 `label`. Es el discriminador correcto, no la ausencia de `url` |
| `purpose` | string enum | `content` (110), `assessment` (17, todos los `assign`), `collaboration` (4). Sirve para agrupar en UI sin hardcodear `modname` |
| `indent` / `groupmode` | int | `0` en los 131 |
| `downloadcontent` | int | `1` en los 131. No se probó que `0` bloquee la descarga |
| `branded` | boolean | `false` en los 131 |
| `onclick` | string | cadena vacía en los 131 |
| `afterlink` | null | `null` en los 131 |
| `modicon` | URL | el nombre del archivo depende del **contenido** (`monologo`, `pdf`, `powerpoint`, `document`, `image`), no del `modname`: no sirve para inferir tipo |
| `modplural` | string **localizado** | el mismo `modname` llegó como `Archivos` y `Files`. Es copy |
| `activitybadge` | array \| ausente | presente y **siempre vacía** en `resource` y `forum`; ausente en el resto. Presencia y contenido no correlacionan |
| `completion` | 0/1 | `0` sin seguimiento (43), `1` manual (88) |
| `completiondata` | object \| **ausente** | presente en los 88 con `completion=1`, ausente en los 43 con `completion=0` |
| `dates[]` | array (0, 1 o 2) | no vacío solo en 17 de 131 |
| `customdata` | string con JSON adentro | ver abajo |
| `contents[]` / `contentsinfo` | array / object \| ausente | presentes en los mismos 95 módulos |

`modname` observados: `url` (43), `resource` (38), `assign` (17), `label` (15),
`page` (11), `folder` (3), `forum` (2), `glossary` (2). **El inventario de estos
3 cursos no es el inventario del sitio**: hay lectores expuestos para 13 modname
más (ver abajo). Un `switch` exhaustivo sobre los 8 vistos, sin rama por
defecto, se rompe el día que un profesor agrega un quiz.

### `completiondata`

| Campo | Tipo | Notas |
|---|---|---|
| `state` | int | `0` (63) y `1` (25). No aparecieron `2` (aprobado) ni `3` (reprobado), que son de finalización automática por nota, y acá nadie configuró eso |
| `timecompleted` | epoch | `0` cuando `state=0`. **Centinela, no null**: formatear eso da 1970 |
| `overrideby` | null | `null` en los 88 |
| `details[]` | array | vacío en los 88: acá la finalización es manual |
| `valueused`, `isautomatic`, `istrackeduser`, `hascompletion`, `uservisible`, `isoverallcomplete` | boolean | `isoverallcomplete` coincidió con `state == 1` en los 88 casos |

La presencia de `completiondata` **no depende del curso**: un curso con
`enablecompletion=true` y `completionusertracked=true` trajo cero
`completiondata` porque su único módulo tenía `completion=0`. La condición es
por módulo. Y `core_completion_get_activities_completion_status(courseid,
userid)` quedó verificada **redundante**: sus 88 filas son los mismos cmid y los
mismos `state` que el `completiondata` embebido, cero discrepancias. Llamarla es
duplicar el tráfico a cambio de nada; se conserva solo como sonda de
diagnóstico.

### `dates[]`

| Campo | Tipo | Notas |
|---|---|---|
| `dataid` | string enum | `duedate` (17) y `allowsubmissionsfromdate` (13). **Este es el campo por el que se identifica una fecha** |
| `label` | string **localizado** | en el mismo volcado llegaron `Abrió:`, `Cierre:`, `Fecha Esperada:`, `Opened:` y `Due:`. Nunca es criterio de parseo |
| `timestamp` | epoch | la fecha en sí |

`dates[]` **omite las fechas que valen 0** en vez de mandarlas en cero. Un módulo
trae 2 entradas, otro 1 y otro ninguna. Indexar por posición (`dates[0]` =
apertura, `dates[1]` = entrega) da la fecha equivocada en cuanto una tarea no
tiene apertura.

### `customdata`

Es un **string con JSON adentro**, y a veces el string es el literal `""` (dos
caracteres, que decodifica a la cadena vacía). La guarda correcta es
`JSON.parse` y después `typeof === 'object'`, nunca `if (customdata)`, porque
ese literal es truthy.

Claves observadas en los 17 `assign`:

| Combinación | Casos |
|---|---:|
| `{duedate, allowsubmissionsfromdate}` | 12 |
| `{duedate, cutoffdate}` | 3 |
| `{duedate, allowsubmissionsfromdate, cutoffdate}` | 1 |
| decodifica a `''` | 1 |

Dentro del mismo objeto los tipos son inconsistentes: **`duedate` llega number y
`allowsubmissionsfromdate` y `cutoffdate` llegan string numérico**. Y el mismo
nombre de campo cambia de tipo según el `modname`: `duedate` es int en los
`assign` y string en el `forum`. `display` llegó int en 80 casos y string en 1
(un `resource`). `displayoptions` no es JSON: es PHP serializado.

### `contents[]` y `contentsinfo`

Ausentes por completo en `assign`, `forum`, `glossary` y `label`. Presentes en
`resource`, `url`, `page` y `folder`, y ahí pueden venir **vacíos** (1 `url` y 2
`folder` con 0 elementos). Un `resource` trajo 3 archivos: la cardinalidad no es
1. Ver el dominio de archivos para el detalle de campos.

`contentsinfo`: `filescount`, `filessize`, `lastmodified`, `mimetypes[]` y
`repositorytype`. **`repositorytype` es una clave ausente** en los 3 módulos con
`filescount=0`, no `null`: acceder sin guardia tira `KeyError`.

### Los campos del curso que gobiernan este dominio

Vienen de `core_enrol_get_users_courses()`, que es de otro dominio pero corre
primero:

| Campo | Valores observados | Uso |
|---|---|---|
| `hidden` | 12 en `false`, el resto en `true` | el filtro barato: los `true` son materias de cuatrimestres pasados |
| `startdate` / `enddate` | epoch | ventana del curso |
| `format` | `tiles` en casi todos, `buttons` en uno | **ningún curso usa `topics`** |
| `lang` | `es`, `es_mx`, `''`, `en` | causa de que `modplural` y `dates[].label` vengan mezclados |
| `enablecompletion` | `true` salvo en uno | **no** implica que sus módulos traigan `completiondata` |
| `showgrades` | `true` salvo en uno | precondición del libro de calificaciones |
| `progress` | number o `null` | `null` en los cursos sin seguimiento de finalización |
| `timemodified` | epoch | **inservible como watermark**: en los 2 cursos medibles el contenido es más nuevo que ese timestamp |
| `overviewfiles[]` | poblado en 3 cursos | imagen del curso, forma corta de 6 campos |

**Cuál es el conjunto activo.** `hidden=false` deja 12 cursos. Añadirle la
ventana `startdate <= ahora <= enddate` los baja a 4, y esos 4 no incluyen
ninguno de los 3 cursos del recon. Recomendación: **filtrar solo por
`hidden=false`** (12 llamadas por ciclo), porque la ventana deja fuera cursos que
todavía tienen contenido reciente y entregas pendientes de corrección.

### Lectores por módulo que el sitio expone y el recon no ejercitó

| Estado | Funciones |
|---|---|
| ejecutada, envoltorio confirmado, elemento sin ver | `mod_quiz_get_quizzes_by_courses` (llamada en los 3 cursos, `{quizzes: [], warnings: []}` en los 3) |
| expuestas, nunca llamadas | `mod_page_get_pages_by_courses` (crítica: el cuerpo de una página hoy solo llega como `index.html` detrás de pluginfile), `mod_url_`, `mod_folder_`, `mod_resource_`, `mod_label_get_labels_by_courses`, `mod_glossary_`, `mod_lesson_`, `mod_choice_`, `mod_feedback_`, `mod_workshop_`, `mod_data_`, `mod_wiki_`, `mod_scorm_`, `mod_h5pactivity_`, `mod_bigbluebuttonbn_`, `mod_lti_`, `mod_book_`, `mod_imscp_` |
| expuestas y sin llamar, del dominio cursos | `core_course_check_updates`, `core_course_get_course_module`, `core_courseformat_get_overview_information`, `core_course_get_contents` con `options[]` (`excludecontents`, `sectionnumber`, `cmid`), `tool_mobile_call_external_functions` |
| **no expuestas** (verificado contra las 438) | `core_course_get_module`, `core_course_edit_module`, `mod_chat_*`, `mod_survey_*`, `mod_attendance_*` |

**`customcert` es un caso aparte**: está instalado, pero por web service solo
expone `mod_customcert_delete_issue`. No hay lector. Si aparece un customcert en
un curso, `get_contents` lo devuelve como módulo pero **no hay forma de leer su
detalle**. Es una limitación dura, no una llamada pendiente. Son 13 modname con
lector, no 14.

`core_courseformat_get_overview_information` importa más de lo que parece: casi
todos los cursos usan `format: 'tiles'` (uno usa `buttons`, ninguno usa
`topics`), así que lo que devuelve `get_contents` es la vista canónica de
Moodle, no necesariamente lo que el estudiante ve en la web.

### Trampas del dominio

- `modules[].url` **no existe** en los `label`. Es la única clave que falta por
  completo en un modname, y son 15 de 131. Un `new URL(m.url)` revienta en el
  primer curso real. El campo correcto para decidir si un módulo se abre es
  `noviewlink`.
- `sections[].section` es la posición, no la identidad. Guardar por número de
  sección significa que reordenar el curso reescribe filas equivocadas.
- Los elementos de `contents[]` tienen **juegos de claves distintos** según
  `type`. Leer `c.mimetype` sin guardia falla en 53 de 96.
- `contents[]` puede venir vacío estando presente. `'contents' in modulo` no
  implica que haya nada que bajar.
- `filename` no garantiza extensión: **45 de 96 no traen punto** y uno termina en
  puntos suspensivos, del que sale una extensión vacía. Derivar el tipo del
  sufijo falla en 46 de 96. El único dato honesto es `mimetype`, que solo existe
  en `resource` y `folder`.
- `description` y `summary` son HTML crudo con `style=` inline, un iframe
  embebido y URLs `pluginfile.php` que exigen token. Renderizarlo sin sanitizar
  mete CSS de terceros en la UI; renderizarlo como texto plano muestra etiquetas.
- `core_enrol_get_users_courses[].timemodified` parece un watermark y no lo es.
  Colgar el delta de ese campo deja el curso desactualizado para siempre.
- `instances: []` de `core_course_get_updates_since` no significa que la función
  no sirva: con `since = ahora - 14 días` y el contenido más nuevo de 45 días, el
  vacío es la respuesta correcta.

### Esquema local

```sql
-- Un bloque de la página del curso. `id` es la identidad; `section_number` es
-- la posición y cambia si el profesor reordena. `sort_index` guarda el índice
-- del array porque la respuesta no trae ningún campo de orden.
CREATE TABLE IF NOT EXISTS pva_course_section (
  section_id        INTEGER PRIMARY KEY,          -- sections[].id
  user_id           INTEGER NOT NULL,
  course_id         INTEGER NOT NULL,
  section_number    INTEGER NOT NULL,             -- sections[].section, 0 = cabecera
  name              TEXT NOT NULL DEFAULT '',     -- puede traer entidades HTML sin decodificar
  summary_html      TEXT NOT NULL DEFAULT '',     -- HTML con style= inline y URLs pluginfile
  summary_format    INTEGER NOT NULL DEFAULT 1,
  visible           INTEGER NOT NULL DEFAULT 1,
  uservisible       INTEGER NOT NULL DEFAULT 1,
  hidden_by_numsecs INTEGER NOT NULL DEFAULT 0,
  component         TEXT,                         -- null en todo el volcado
  item_id           INTEGER,                      -- null en todo el volcado
  sort_index        INTEGER NOT NULL,             -- índice en el array de la respuesta
  seen_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pva_section_course
  ON pva_course_section (user_id, course_id, sort_index);

-- Un módulo de la página. `cmid` es LA identidad entre sincronizaciones.
--   * `url` es NULL en los label y solo en los label; `no_view_link` dice lo
--     mismo de forma explícita y es el discriminador que hay que usar.
--   * `completion_state` es NULL cuando `completion_rule` = 0, y eso depende del
--     módulo, no del curso.
--   * `customdata_json` se guarda CRUDO: adentro conviven tipos distintos para
--     el mismo nombre de campo y un valor serializado por PHP. Normalizarlo al
--     guardar sería inventar.
CREATE TABLE IF NOT EXISTS pva_module (
  cmid                INTEGER PRIMARY KEY,        -- modules[].id
  user_id             INTEGER NOT NULL,
  course_id           INTEGER NOT NULL,
  section_id          INTEGER NOT NULL REFERENCES pva_course_section(section_id) ON DELETE CASCADE,
  sort_index          INTEGER NOT NULL,           -- índice dentro de modules[]
  modname             TEXT NOT NULL,              -- url|resource|assign|label|page|folder|forum|glossary|...
  instance            INTEGER NOT NULL,
  context_id          INTEGER NOT NULL,           -- aparece en la ruta de los fileurl
  name                TEXT NOT NULL,
  url                 TEXT,                       -- NULL en label
  description_html    TEXT,                       -- NULL cuando la clave no vino; '' cuando vino vacía
  visible             INTEGER NOT NULL DEFAULT 1,
  uservisible         INTEGER NOT NULL DEFAULT 1,
  visible_on_page     INTEGER NOT NULL DEFAULT 1,
  no_view_link        INTEGER NOT NULL DEFAULT 0, -- 1 = se pinta, no se abre
  can_display         INTEGER NOT NULL DEFAULT 1,
  purpose             TEXT,                       -- content|assessment|collaboration
  indent              INTEGER NOT NULL DEFAULT 0,
  group_mode          INTEGER NOT NULL DEFAULT 0,
  download_content    INTEGER NOT NULL DEFAULT 1,
  icon_url            TEXT,                       -- depende del contenido, no del modname
  completion_rule     INTEGER NOT NULL DEFAULT 0, -- 0 sin seguimiento, 1 manual
  completion_state    INTEGER,                    -- NULL si completion_rule = 0
  completed_at        INTEGER,                    -- epoch; 0 es el centinela de "no completado"
  completion_override_by INTEGER,
  completion_automatic   INTEGER,
  completion_tracked     INTEGER,
  customdata_json     TEXT,                       -- crudo: string JSON, o el literal ""
  content_hash        TEXT,                       -- sha256 del subárbol, para el delta local
  seen_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pva_module_section
  ON pva_module (user_id, section_id, sort_index);
CREATE INDEX IF NOT EXISTS idx_pva_module_kind
  ON pva_module (user_id, course_id, modname);
-- La pareja que necesitan mod_assign, mod_forum y los demás lectores. En el
-- volcado `instance` salió único por sí solo, pero la clave del modelo de
-- Moodle es la pareja.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pva_module_instance
  ON pva_module (modname, instance);

-- Las fechas que la PVA muestra bajo un módulo. Tabla aparte porque el array
-- trae 0, 1 o 2 elementos. La clave es `data_id`, NUNCA `label`, que viene
-- traducido al idioma del curso. En el volcado ningún cmid repitió data_id; si
-- algún día se repite, esta PK pierde la segunda fecha.
CREATE TABLE IF NOT EXISTS pva_module_date (
  cmid       INTEGER NOT NULL REFERENCES pva_module(cmid) ON DELETE CASCADE,
  data_id    TEXT NOT NULL,                       -- duedate | allowsubmissionsfromdate
  ts         INTEGER NOT NULL,                    -- epoch en segundos
  label      TEXT,                                -- localizado, solo para mostrar
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (cmid, data_id)
);

-- El reloj del sync por curso. `hash_tree` permite descartar una respuesta
-- entera sin recorrerla.
CREATE TABLE IF NOT EXISTS pva_course_sync (
  user_id        INTEGER NOT NULL,
  course_id      INTEGER NOT NULL,
  contents_at    TEXT,                            -- ISO del último get_contents ok
  server_since   INTEGER,                         -- epoch enviado en el último delta
  hash_tree      TEXT,                            -- sha256 de la respuesta normalizada
  sections       INTEGER,
  modules        INTEGER,
  last_error     TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, course_id)
);
```

Un módulo que desaparece de `get_contents` **no se elimina**: se marca `seen_at`
viejo y se filtra. Un cmid puede volver (sección ocultada y reabierta) y borrar
en duro se lleva por delante el historial local.

## Tareas y estado de entrega

Dos funciones. `mod_assign_get_assignments(courseids[])` da el catálogo, un
elemento de `courses[]` por curso pedido **aunque el curso no tenga tareas**
(llega con `assignments: []`). `mod_assign_get_submission_status(assignid)` da
el estado vivo de una tarea, y es la única fuente de si todavía se puede tocar.

Muestra: 17 tareas en 3 cursos (12, 5 y 0), 6 warnings, 3 estados de entrega.

### `mod_assign_get_assignments`

`courses[]`: `id`, `fullname`, `shortname`, `timemodified` (última modificación
del conjunto de tareas del curso), `assignments[]`.

`assignments[]` tiene 37 claves. Las que deciden algo:

| Campo | Tipo | Observado | Significado |
|---|---|---|---|
| `id` | int | | `assign.id`. Es lo que recibe `get_submission_status` |
| `cmid` | int | | **la clave de join** con `core_course_get_contents[].modules[].id`, con `gradeitems[].cmid` y con `events[].instance` |
| `course` | int | | curso al que pertenece |
| `name` | string | | título |
| `duedate` | epoch | 16 con valor, 1 en `0` | fecha de entrega. `0` = **no hay** fecha límite |
| `allowsubmissionsfromdate` | epoch | 13 con valor, 4 en `0` | apertura. `0` = abierta desde siempre |
| `cutoffdate` | epoch | 13 en `0`, 3 con `cutoff > due`, 1 con `cutoff == due` | corte duro. `0` = se acepta tarde **indefinidamente**; `cutoff == due` = no se acepta nada tarde |
| `gradingduedate` | epoch | `0` en las 17 | compromiso del profesor, no dato del estudiante |
| `timelimit` | segundos | `0` en las 17 | cronómetro de la entrega |
| `timemodified` | epoch | | detector de cambio a nivel tarea |
| `grade` | int | `0`, 5, 10, 15, 20, 100 | `> 0` máximo numérico; `0` tarea sin calificación; negativo = `-scaleid` según protocolo, **no visto** |
| `submissiondrafts` | 0/1 | `0` en las 17 | `1` = existe etapa de borrador que hay que confirmar. **En esta instancia el estado `draft` no ocurre** |
| `requiresubmissionstatement` | 0/1 | `0` en las 17 | `1` = hay que aceptar la declaración de autoría |
| `attemptreopenmethod` | string enum | `untilpass` en las 17 | `none` y `manual` son del protocolo, no vistos |
| `maxattempts` | int | **`1` en las 17** | `-1` = ilimitados es convención de Moodle, no observada |
| `completionsubmit` | 0/1 | 12 en `1` | entregar marca la actividad como completa |
| `markingworkflow` | 0/1 | `0` en las 17 | con `1` la nota puede existir y no ser visible |
| `nosubmissions`, `teamsubmission`, `blindmarking`, `revealidentities`, `markinganonymous`, `markingallocation`, `hidegrader`, `preventsubmissionnotingroup`, `requireallteammemberssubmit`, `submissionattachments`, `gradepenalty` | 0/1 | `0` en las 17 | |
| `sendnotifications` / `sendlatenotifications` / `sendstudentnotifications` | 0/1 | 16-1 / 0 / 1 | avisos a correctores y al estudiante |
| `intro` / `introformat` | HTML / int | 2 de 17 vacíos, formato `1` | enunciado |
| `introfiles[]` | array | `[]` en las 17 | archivos incrustados en el enunciado |
| `introattachments[]` | array | 8 de 17 traen uno, 9 traen `[]` | adjuntos del enunciado |
| `configs[]` | array(8) | igual en las 17 | configuración de plugins, aplanada |

`configs[]` es `{subtype, plugin, name, value}` y **`value` es siempre string**,
incluso los números y los booleanos (`'1'`, `'0'`, `'10'`, `'524288000'`, `''`).
Comparar contra `1` o contra `true` da falso en todos los casos.

| subtype | plugin | claves |
|---|---|---|
| `assignsubmission` | `file` | `enabled`, `filetypeslist` (`''` = cualquier extensión), `maxfilesubmissions`, `maxsubmissionsizebytes` |
| `assignfeedback` | `comments` | `enabled`, `commentinline` |
| `assignfeedback` | `editpdf` | `enabled` |
| `assignfeedback` | `file` | `enabled` |

**`assignsubmission/onlinetext` no aparece en ninguna de las 17.** Un parser que
busque el bloque de texto en línea encuentra ausencia, no `enabled='0'`. La regla
que aguanta es: plugin ausente = no disponible.

`warnings[]` no es ruido: lista módulos que el estudiante **no puede ver** (4 en
un curso, 2 en otro), con `item: 'module'`, `itemid` = cmid, `warningcode` que
llega como **string `'1'`** y un `message` en inglés. Esos cmid no aparecen en el
contenido visible del curso, así que no se pueden unir con nada.

### `mod_assign_get_submission_status`

En el recon se llamó solo con `assignid`. `userid` y `groupid` existen como
opcionales según el protocolo, pero eso es supuesto.

La respuesta es un **union discriminado**: con `lastattempt.gradingstatus =
'graded'` aparece la clave `feedback`; con `'notgraded'` **la clave no existe**.
No llega `null` ni `{}`: no está. Un `data['feedback']['grade']` revienta en 2
de las 3 respuestas del volcado.

`lastattempt`:

| Campo | Tipo | Observado |
|---|---|---|
| `submission` | object | presente en las 3. Según protocolo puede faltar si nunca se abrió un intento; ese caso no se vio |
| `submissionsenabled` | boolean | `true` |
| `locked` | boolean | `false` |
| `graded` | boolean | `true` en 1 de 3 |
| `gradingstatus` | string enum | `graded` y `notgraded`. Con `markingworkflow=1` el protocolo devuelve estados del flujo, no vistos |
| `canedit` | boolean | `true` en 2, `false` en 1 |
| `caneditowner` | boolean | acompaña a `canedit` en los 3 casos |
| `cansubmit` | boolean | **`false` en las 3**, incluso en las editables |
| `extensionduedate` | int **o null** | `0` en una, **`null` en dos**. Los dos significan sin prórroga |
| `timelimit` | int | `0` |
| `blindmarking` | boolean | `false` |
| `usergroups[]` | array | `[]` |
| `submissiongroupmemberswhoneedtosubmit[]` | array | `[]` |

`lastattempt.submission`:

| Campo | Tipo | Observado |
|---|---|---|
| `id` | int | aparece dentro de la `fileurl` de los archivos entregados |
| `userid`, `assignment` | int | dueño y redundancia del parámetro |
| `attemptnumber` | int | **base 0**. Tratarlo como "intento 1" desplaza toda la numeración |
| `latest` | 0/1 | `1` |
| `status` | string enum | `submitted` en las 3. `new`, `draft` y `reopened` son del protocolo, no vistos |
| `timecreated` / `timemodified` | epoch | `timemodified` coincide con el del archivo entregado. **Es la fecha que se compara contra `duedate`** para decidir si fue tarde |
| `timestarted` | **null** | `null` en las 3 porque `timelimit` es 0 |
| `groupid` | int | `0` = individual |
| `plugins[]` | array(1) | solo el plugin habilitado |

`plugins[]`: `{type, name, fileareas[], editorfields?[]}`. **`type` es la clave
estable** (`file`); `name` (`File submissions`) es copy localizable. El único
filearea visto en la entrega es `submission_files`, con 1 o 2 archivos.

`feedback` (solo cuando `gradingstatus = 'graded'`):

| Campo | Tipo | Notas |
|---|---|---|
| `grade.grade` | **string decimal** de 5 decimales | hay que parsear. `'-1.00000'` = sin nota según protocolo, no visto |
| `grade.grader` | int | userid del corrector. `-1` cuando califica el sistema es supuesto |
| `grade.attemptnumber`, `.timecreated`, `.timemodified`, `.id`, `.assignment`, `.userid` | | identidad de la fila de nota |
| `gradefordisplay` | string **HTML** | trae entidades crudas (`&nbsp;`). Copy del servidor, no fuente numérica |
| `gradeddate` | epoch | coincide con `grade.timemodified` en el caso visto |
| `plugins[]` | array(3) | `comments`, `editpdf`, `file` |

`comments` trae `editorfields[]` con `{name: 'comments', description, text
(HTML), format}`. **Los `editorfields` viven en el lado feedback, no en la
entrega.**

`editpdf` trae **9 fileareas** y solo 4 con archivos:

| Área | Archivos | Qué es |
|---|---:|---|
| `combined` | 1 PDF | **la corrección real**, lo único que hay que guardar |
| `pages` | 6 PNG | rasterizado de la entrega |
| `readonlypages` | 6 PNG | duplicado byte a byte de `pages` |
| `stamps` | 5 PNG | sellos del corrector (`cross`, `qmark`, `sad`...): **no es retroalimentación del estudiante** |
| `download`, `partial`, `importhtml`, `tmp_jpg_to_pdf`, `tmp_rotated_jpg` | 0 | vacías |

Guardar `feedback` sin filtrar mete 18 imágenes por tarea calificada. Hay que
quedarse con `combined` y descartar `pages`, `readonlypages` y `stamps`
explícitamente.

`assignmentdata.attachments.intro[]` llegó `[]` en las 3, coherente con que esas
3 tareas no tienen adjuntos de enunciado. **No hay ningún caso en el volcado de
una tarea con `introattachments` consultada por `get_submission_status`**, así
que si esta copia es fiable queda pendiente de probar. La fuente segura de los
adjuntos del enunciado es `introattachments` de `get_assignments`.

### Cómo se deriva el estado que ve el estudiante

No es un campo, es una derivación, y **la editabilidad no es un solo booleano**:
es `canedit` + `caneditowner` + `cansubmit` + `locked` + `submissionsenabled` +
fecha efectiva (`extensionduedate` si existe, si no `cutoffdate` y `duedate`)
contra la hora actual.

En el volcado `cansubmit` fue `false` en las 3, incluso donde `canedit` era
`true`: con `submissiondrafts=0` no hay paso de confirmación, así que un botón
"Entregar" condicionado a `cansubmit` **nunca se habilita**. La edición se rige
por `canedit`.

`canedit` no se deriva del `status` (las 3 estaban `submitted` y una dio
`false`), pero en el volcado **sí sigue exactamente al `cutoffdate`**: cutoff
pasado da `false`, cutoff `0` o inexistente da `true`. Aun así, la fuente es el
servidor: se usa `canedit`, no la fecha recalculada.

### Trampas del dominio

- `0` en una fecha significa "no hay fecha". Aplica a `duedate` (1 de 17),
  `allowsubmissionsfromdate` (4), `cutoffdate` (13) y `gradingduedate` (17). Un
  formateador ingenuo pinta "Vence: 31 dic 1969" por la zona UTC-4.
- `cutoffdate = 0` no significa "cierra el mismo día que vence": significa que se
  acepta tarde indefinidamente. Y `cutoffdate == duedate` significa lo
  contrario. Son los dos extremos y se distinguen solo por ese cero.
- `extensionduedate` cambia de tipo dentro del mismo volcado: `0` en una
  respuesta, `null` en las otras dos. Un tipo `int` estricto falla y un
  `if (extensionduedate is not None)` da falso positivo.
- `feedback.grade.grade` es un string decimal, no un número. Ordenar notas como
  texto pone `'9.00000'` después de `'12.50000'`.
- `status = 'submitted'` no implica calificada ni implica a tiempo. Hay que
  cruzar `submission.timemodified` contra `duedate` (o `extensionduedate`) para
  el atraso, y `gradingstatus` para la nota.
- `events[].instance` del calendario **es el cmid**, no `assign.id`. El join es
  contra `assignment.cmid`.
- El objeto `courses[]` existe aunque el curso no tenga tareas.
- `gradereport_user_get_grade_items` falló con `nopermissiontoviewgrades` en 1 de
  los 3 cursos. Un ciclo que aborte al primer error deja de sincronizar el resto.
- `core_files_upload` no está entre las 438. Una función de "entregar archivo"
  escrita de memoria contra esa `wsfunction` falla con un error opaco, no con un
  404 claro.

### Esquema local

```sql
-- Regla de fechas: el 0 que manda Moodle NO es 1970, es "no hay fecha". Se
-- normaliza a NULL al escribir y se vuelve a 0 solo si algo se manda de regreso.
CREATE TABLE IF NOT EXISTS pva_assignment (
  assignment_id              INTEGER PRIMARY KEY,        -- assign.id
  user_id                    INTEGER NOT NULL,
  cmid                       INTEGER NOT NULL UNIQUE,    -- join con módulos, grade items y calendario
  course_id                  INTEGER NOT NULL,
  name                       TEXT    NOT NULL,
  intro_html                 TEXT    NOT NULL DEFAULT '',
  intro_format               INTEGER NOT NULL DEFAULT 1,
  duedate                    INTEGER,                    -- NULL = sin fecha límite
  allowsubmissionsfromdate   INTEGER,                    -- NULL = abierta desde siempre
  cutoffdate                 INTEGER,                    -- NULL = acepta tarde sin límite
  gradingduedate             INTEGER,
  timelimit_s                INTEGER NOT NULL DEFAULT 0,
  grade_max                  INTEGER NOT NULL DEFAULT 0, -- >0 puntaje; 0 sin calificación; <0 = -scaleid
  nosubmissions              INTEGER NOT NULL DEFAULT 0,
  submissiondrafts           INTEGER NOT NULL DEFAULT 0, -- 0 = no existe etapa de borrador
  requiresubmissionstatement INTEGER NOT NULL DEFAULT 0,
  attemptreopenmethod        TEXT    NOT NULL DEFAULT 'none',
  maxattempts                INTEGER NOT NULL DEFAULT 1, -- 1 en las 17 observadas
  completionsubmit           INTEGER NOT NULL DEFAULT 0,
  teamsubmission             INTEGER NOT NULL DEFAULT 0,
  blindmarking               INTEGER NOT NULL DEFAULT 0,
  markingworkflow            INTEGER NOT NULL DEFAULT 0, -- 1 = la nota puede existir y no verse
  gradepenalty               INTEGER NOT NULL DEFAULT 0,
  sendstudentnotifications   INTEGER NOT NULL DEFAULT 1,
  remote_timemodified        INTEGER NOT NULL,           -- detector de cambio del servidor
  fetched_at                 INTEGER NOT NULL,
  CHECK (attemptreopenmethod IN ('none','manual','untilpass')),
  CHECK (duedate    IS NULL OR duedate    > 0),
  CHECK (cutoffdate IS NULL OR cutoffdate > 0)
);
CREATE INDEX IF NOT EXISTS idx_pva_assignment_course ON pva_assignment(user_id, course_id);
-- El índice parcial deja fuera las de duedate NULL, que nunca entran en una
-- vista de "próximas entregas".
CREATE INDEX IF NOT EXISTS idx_pva_assignment_due
  ON pva_assignment(duedate) WHERE duedate IS NOT NULL;

-- configs[] aplanado tal cual llega. value es TEXT porque el servidor manda
-- TODO como string. La ausencia de una fila es tan informativa como
-- enabled='0': onlinetext no aparece en ninguna tarea.
CREATE TABLE IF NOT EXISTS pva_assignment_config (
  assignment_id INTEGER NOT NULL REFERENCES pva_assignment(assignment_id) ON DELETE CASCADE,
  subtype       TEXT NOT NULL,   -- assignsubmission | assignfeedback
  plugin        TEXT NOT NULL,   -- file | comments | editpdf
  name          TEXT NOT NULL,
  value         TEXT NOT NULL,
  PRIMARY KEY (assignment_id, subtype, plugin, name)
);

-- Tareas que el servidor dice que existen pero el estudiante no puede ver.
-- Su cmid NO aparece en el contenido visible, así que no hay a qué unirlo.
CREATE TABLE IF NOT EXISTS pva_assignment_inaccessible (
  user_id     INTEGER NOT NULL,
  course_id   INTEGER NOT NULL,
  cmid        INTEGER NOT NULL,
  warningcode TEXT    NOT NULL,   -- '1' llega como string
  message     TEXT    NOT NULL,   -- copy del servidor, no parsear
  fetched_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, course_id, cmid)
);

-- El intento vigente. Si algún día aparece `previousattempts`, entra acá con
-- is_latest = 0.
CREATE TABLE IF NOT EXISTS pva_submission (
  assignment_id       INTEGER NOT NULL REFERENCES pva_assignment(assignment_id) ON DELETE CASCADE,
  attemptnumber       INTEGER NOT NULL,          -- base 0
  submission_id       INTEGER,                   -- NULL si el intento no existe todavía
  user_id             INTEGER NOT NULL,
  status              TEXT    NOT NULL,          -- new|draft|submitted|reopened
  is_latest           INTEGER NOT NULL DEFAULT 1,
  group_id            INTEGER NOT NULL DEFAULT 0,
  timecreated         INTEGER,
  timemodified        INTEGER,                   -- se compara contra duedate para el atraso
  timestarted         INTEGER,                   -- NULL salvo con cronómetro
  submissions_enabled INTEGER NOT NULL DEFAULT 1,
  locked              INTEGER NOT NULL DEFAULT 0,
  graded              INTEGER NOT NULL DEFAULT 0,
  can_edit            INTEGER NOT NULL DEFAULT 0,
  can_edit_owner      INTEGER NOT NULL DEFAULT 0,
  can_submit          INTEGER NOT NULL DEFAULT 0,
  grading_status      TEXT    NOT NULL,          -- graded|notgraded|estados de markingworkflow
  extensionduedate    INTEGER,                   -- llega 0 o null; ambos = sin prórroga -> NULL
  timelimit_s         INTEGER NOT NULL DEFAULT 0,
  blindmarking        INTEGER NOT NULL DEFAULT 0,
  fetched_at          INTEGER NOT NULL,
  PRIMARY KEY (assignment_id, attemptnumber),
  CHECK (status IN ('new','draft','submitted','reopened')),
  CHECK (extensionduedate IS NULL OR extensionduedate > 0)
);
CREATE INDEX IF NOT EXISTS idx_pva_submission_status
  ON pva_submission(status, grading_status);

-- La nota. Fila que solo existe cuando la respuesta trae la clave 'feedback'.
CREATE TABLE IF NOT EXISTS pva_submission_feedback (
  assignment_id     INTEGER NOT NULL,
  attemptnumber     INTEGER NOT NULL,
  grade_id          INTEGER,
  grade_value       REAL,      -- parseado del string
  grade_raw_text    TEXT,      -- el string original: no pierde precisión ni el '-1.00000'
  grade_for_display TEXT,      -- HTML con entidades; solo para mostrar, nunca para calcular
  graded_date       INTEGER,
  grader_user_id    INTEGER,
  timecreated       INTEGER,
  timemodified      INTEGER,
  comment_html      TEXT,      -- plugins[type='comments'].editorfields[name='comments'].text
  comment_format    INTEGER,
  PRIMARY KEY (assignment_id, attemptnumber),
  FOREIGN KEY (assignment_id, attemptnumber)
    REFERENCES pva_submission(assignment_id, attemptnumber) ON DELETE CASCADE
);
```

Los archivos de entrega, de enunciado y de corrección viven en el esquema de
archivos (`pva_file`), no acá.

## Libro de calificaciones

Dos funciones, con costes muy distintos.
`gradereport_overview_get_course_grades(userid)` es **una sola llamada** y trae
el total de todos los cursos. `gradereport_user_get_grade_items(courseid,
userid)` es **una llamada por curso** y trae el detalle por item.

Precondición dura: `core_enrol_get_users_courses[].showgrades`. Cuando es
`false` el libro de ese curso es inalcanzable por las dos funciones.

### `gradereport_overview_get_course_grades`

`{grades[], warnings[]}`. Devuelve una fila por curso con el libro visible, y
`warnings` llegó vacío.

| Campo | Tipo | Observado |
|---|---|---|
| `courseid` | int | une contra `core_enrol_get_users_courses.id` |
| `grade` | string | total redondeado a 2 decimales, o `'-'`. **La gran mayoría en `'-'`** |
| `rawgrade` | string \| null | mismo total con 5 decimales. `null` en la mayoría, **string en unos pocos** |

**Omite en silencio los cursos sin permiso**, sin un solo warning: el curso con
`showgrades: false` simplemente no aparece en la lista. Un parser que asuma
paridad con `core_enrol_get_users_courses`, o que haga `zip` por índice, cruza
notas con cursos equivocados.

En todos los casos con valor, `rawgrade` redondeado coincide con `grade`. Aun así
**se compara `rawgrade`, en texto**: `grade` depende de los decimales de
visualización del sitio, así que dos totales distintos pueden redondear igual y
un cambio de formato del admin dispara falsos positivos en todos los cursos.

Nota de esqueleto: `_formas.json` documenta `rawgrade` como `'null'` porque
infirió la forma del primer elemento del array. En el archivo real varios son
string. **Programar contra el esqueleto en vez del volcado da el tipo equivocado
en el campo más importante de esa función.**

### `gradereport_user_get_grade_items`

`{usergrades[], warnings[]}`. `usergrades` tiene siempre longitud 1 cuando se
pide un `userid`.

`usergrades[]`: `courseid`, `courseidnumber`, `userid`, `userfullname`,
`useridnumber` (los dos últimos son PII, no se persisten), `maxdepth` (`2` en
los dos cursos: solo total de curso más hojas), `gradeitems[]`.

`gradeitems[]`, 26 o 27 claves según `itemtype`:

| Campo | Tipo | Observado |
|---|---|---|
| `id` | int | **PK global de `grade_items` en Moodle**, única entre cursos. Es la clave de sincronización, sobrevive renombres |
| `itemname` | string \| **null** | `null` cuando `itemtype` no es `mod`. Trae entidades HTML sin decodificar |
| `itemtype` | string | `mod` y `course`. `category`, `manual` y `outcome` son del protocolo, no vistos |
| `itemmodule` | string \| null | `assign`. `null` en `course` |
| `iteminstance` | int | en `mod` es `assign.id`; en `course` es el id de la `grade_category` raíz, y **es el valor al que apuntan los `categoryid` de los hijos** |
| `itemnumber` | int \| null | `0` en `mod`, `null` en `course` |
| `cmid` | int, **clave ausente en `course`** | une el item con el módulo y con el enlace web |
| `categoryid` | int \| null | `null` en el total del curso |
| `idnumber` | string \| null | `''` en `mod`, `null` en `course` |
| `outcomeid`, `scaleid` | null | siempre `null`: todo es numérico |
| `locked`, `gradeislocked`, `gradeisoverridden` | **tri-estado** | siempre `null`, nunca `false` |
| `gradeishidden`, `gradehiddenbydate`, `gradeneedsupdate` | boolean | siempre `false` |
| `graderaw` | number \| null | **`null` en el 100% de los items de los 2 cursos consultados** |
| `gradedatesubmitted` | epoch \| null | cuándo entregó **el estudiante**. 9 de 13 items la traen con `graderaw` y `gradedategraded` en `null` |
| `gradedategraded` | epoch \| null | cuándo calificó **el profesor**. Es el campo de detección. **Nunca se observó no nulo** |
| `gradeformatted` | string | dos centinelas distintos: `'-'` y `''` |
| `percentageformatted` | string | mismos dos centinelas |
| `rangeformatted` | string | con entidad HTML (`0&ndash;100`, `0&ndash;20`, `0&ndash;0`, `&ndash;` pelado) |
| `grademin` / `grademax` | number | `0` siempre / `0`, 20, 100 |
| `feedback` / `feedbackformat` | HTML / int | cadena vacía y `0` (`FORMAT_MOODLE`) en todo el volcado |

**Cuando falla no devuelve `warnings`: lanza excepción** con `errorcode`
`nopermissiontoviewgrades`. Un cliente que solo revise `warnings` y siga adelante
trata un error de permisos como un libro vacío, y con la lógica de delta eso
equivale a borrar todas las notas del curso.

### Los dos centinelas de "sin nota" significan cosas distintas

| `gradeformatted` | `rangeformatted` | Significa |
|---|---|---|
| `'-'` | `0&ndash;100` | item calificable **todavía sin nota** |
| `''` | `&ndash;` pelado | item que **no califica** (el assign correspondiente tiene `grade=0`), y aun así reporta `grademax=100` |
| `'-'` | `0&ndash;0` | total de curso de un libro **sin ningún item calificable** |

Tratar `''` como "pendiente" deja un item colgado como pendiente para siempre, y
confiar en `grademax` para saber si califica es falso. La regla que aguanta:
`is_gradable = 0` cuando `rangeformatted` no trae dígitos **o** cuando
`grademax` es `0`.

### Lo que el libro no cuenta

El curso con `showgrades=false` está ausente del overview y
`gradereport_user_get_grade_items` le lanza excepción, pero
`mod_assign_get_submission_status` devuelve `gradingstatus: 'graded'` con
`feedback.grade` y `feedback.gradeddate`. **Una app que solo lea el libro le va a
decir al estudiante que no tiene ninguna nota mientras el profesor ya publicó.**
El libro no es la fuente completa de verdad de las calificaciones en esta
instancia.

Balance de la evidencia: el overview expuso unos pocos totales de curso con
valor numérico, y `get_submission_status` expuso una nota de item en el curso
sin libro. **El detalle por item nunca apareció en
`gradereport_user_get_grade_items`**: 2 cursos, 14 items, `graderaw` y
`gradedategraded` en `null` en todos. Es decir, el campo que sostiene toda la
detección de "nota nueva" nunca se observó poblado, y los cursos con total real
nunca se sondearon por item.

### Orden, jerarquía y notificaciones

El orden de `gradeitems` **no es por id ni alfabético**: es el `sortorder` del
libro que define el profesor. El total del curso salió último en un curso y
único en otro: no se puede asumir ni primero ni último, se localiza por
`itemtype`. Y hay que persistir el índice del array o se pierde el orden que el
estudiante ve en la web.

La relación padre-hijo va **cruzada**: `gradeitems[].categoryid` apunta a
`gradeitems[].iteminstance` del item de categoría, no al campo que el nombre
sugiere. El total del curso trae `categoryid: null`.

El total del curso **se recalcula cada vez que se califica cualquier item**. Si
el disparador de notificaciones incluye `itemtype = 'course'`, cada nota
publicada genera dos avisos. Se le lleva su propio evento aparte.

### Funciones que faltan

| Ausente del recon | Por qué importa |
|---|---|
| `gradereport_user_get_access_information(courseid)` | expuesta, no llamada. **La más urgente**: diría si el usuario puede ver el reporte ANTES de llamar, y ahorra el try/catch sobre `nopermissiontoviewgrades` |
| `gradereport_user_get_grades_table(courseid, userid)` | expuesta, no llamada. Devuelve la tabla renderizada con filas de categoría y columnas de peso. Sin ella no sabemos si PUCMM usa categorías con peso ni cómo se calcula el total |
| `core_grades_get_gradeitems` | expuesta, no llamada. Falta saber si es accesible con rol estudiante |
| un volcado con al menos un item **ya calificado** | sin él, la forma poblada de `graderaw` y `gradedategraded` es supuesto |
| un volcado con `maxdepth > 2` o con `scaleid` no nulo | para ver un `itemtype: 'category'` vivo y qué trae `gradeformatted` con escala |
| `mod_quiz_get_user_best_grade`, `mod_lesson_get_user_grade` | existen, no aplican todavía: no hay quiz ni lesson en la muestra |

### Esquema local

```sql
-- Un renglón por item del libro. Sobrevive a que el item desaparezca del payload.
CREATE TABLE IF NOT EXISTS pva_grade_item (
  item_id        INTEGER PRIMARY KEY,            -- gradeitems[].id, PK global de Moodle
  user_id        INTEGER NOT NULL,
  course_id      INTEGER NOT NULL,
  itemtype       TEXT    NOT NULL
                 CHECK (itemtype IN ('mod','course','category','manual','outcome')),
  itemmodule     TEXT,                           -- 'assign' visto; NULL fuera de itemtype='mod'
  iteminstance   INTEGER NOT NULL,               -- id del módulo si 'mod'; id de grade_category si no
  itemnumber     INTEGER,
  cmid           INTEGER,                        -- la clave NO viene en itemtype='course'
  category_id    INTEGER,                        -- padre; NULL en el total del curso
  idnumber       TEXT,
  itemname       TEXT,                           -- NULL en 'course'/'category': la etiqueta la pone la app
  grademin       REAL    NOT NULL,
  grademax       REAL    NOT NULL,               -- puede quedar en 100 aunque el item no califique
  scaleid        INTEGER,
  outcomeid      INTEGER,
  locked         INTEGER,                        -- tri-estado 0/1/NULL
  sort_index     INTEGER NOT NULL,               -- índice en el array: el orden del profesor
  is_gradable    INTEGER NOT NULL DEFAULT 1,     -- 0 si rangeformatted no trae dígitos o grademax = 0
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pva_grade_item_course ON pva_grade_item (user_id, course_id, sort_index);
CREATE INDEX IF NOT EXISTS idx_pva_grade_item_cmid   ON pva_grade_item (cmid) WHERE cmid IS NOT NULL;
-- El padre de un item se resuelve por (course_id, iteminstance) del item de categoría.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pva_grade_item_cat
  ON pva_grade_item (course_id, iteminstance) WHERE itemtype IN ('course','category');

-- Estado actual de la nota. Separado del item porque cambia con otro ritmo.
CREATE TABLE IF NOT EXISTS pva_grade_value (
  item_id             INTEGER PRIMARY KEY REFERENCES pva_grade_item(item_id) ON DELETE CASCADE,
  graderaw            REAL,                      -- NULL = sin nota
  graderaw_src        TEXT,                      -- el valor tal como llegó, para comparar sin drift de float
  gradedatesubmitted  INTEGER,                   -- entregó el ESTUDIANTE. NO es señal de calificación
  gradedategraded     INTEGER,                   -- calificó el PROFESOR. Ésta sí lo es
  grade_display       TEXT NOT NULL,             -- gradeformatted crudo, entidades incluidas
  percentage_display  TEXT NOT NULL,
  range_display       TEXT NOT NULL,
  feedback_html       TEXT NOT NULL DEFAULT '',
  feedback_format     INTEGER NOT NULL DEFAULT 0,
  is_hidden           INTEGER NOT NULL DEFAULT 0,
  hidden_by_date      INTEGER NOT NULL DEFAULT 0,
  needs_update        INTEGER NOT NULL DEFAULT 0,
  is_locked           INTEGER,                   -- tri-estado
  is_overridden       INTEGER,                   -- tri-estado
  fetched_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pva_grade_value_graded
  ON pva_grade_value (gradedategraded) WHERE gradedategraded IS NOT NULL;

-- Bitácora de cambios: evita notificar dos veces y permite mostrar "qué cambió
-- desde la última vez que abriste".
CREATE TABLE IF NOT EXISTS pva_grade_change (
  change_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id         INTEGER NOT NULL REFERENCES pva_grade_item(item_id) ON DELETE CASCADE,
  kind            TEXT    NOT NULL
                  CHECK (kind IN ('published','regraded','unhidden','removed','total_moved')),
  old_raw_src     TEXT,
  new_raw_src     TEXT,
  old_graded_at   INTEGER,
  new_graded_at   INTEGER,
  detected_at     INTEGER NOT NULL,
  notified_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pva_grade_change_pending
  ON pva_grade_change (detected_at) WHERE notified_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pva_grade_change_fact
  ON pva_grade_change (item_id, kind, COALESCE(new_graded_at,-1), COALESCE(new_raw_src,''));

-- Total por curso. Vive aparte porque una sola llamada la llena entera y llega
-- antes que el detalle.
CREATE TABLE IF NOT EXISTS pva_course_total (
  user_id        INTEGER NOT NULL,
  course_id      INTEGER NOT NULL,
  grade_display  TEXT NOT NULL,                  -- '-' o el número redondeado a 2 decimales
  rawgrade_src   TEXT,                           -- 5 decimales, en texto: es lo que se compara
  rawgrade       REAL,                           -- derivado, solo para cálculos
  fetched_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, course_id)
);

-- Por qué un curso no tiene libro. Sin esto el fallback no sabe a quién aplicarse.
CREATE TABLE IF NOT EXISTS pva_gradebook_access (
  user_id        INTEGER NOT NULL,
  course_id      INTEGER NOT NULL,
  show_grades    INTEGER NOT NULL,               -- core_enrol_get_users_courses.showgrades
  reachable      INTEGER NOT NULL,               -- 0 si la última llamada lanzó excepción
  last_errorcode TEXT,                           -- 'nopermissiontoviewgrades'
  last_ok_at     INTEGER,
  last_try_at    INTEGER NOT NULL,
  in_overview    INTEGER NOT NULL DEFAULT 0,     -- apareció en el overview
  PRIMARY KEY (user_id, course_id)
);
```

Reglas de emisión de "nota publicada", que dependen enteramente de esta bitácora:

1. el item ya existía con al menos un sync previo exitoso (**el primer sync
   siembra, nunca notifica**);
2. y `graderaw` pasa de `NULL` a no nulo, **o** `gradedategraded` cambia, **o**
   `gradeishidden` pasa de `true` a `false` teniendo `graderaw` no nulo.

Se suprime cuando `gradeneedsupdate` es `true` (el valor es provisional y el cron
lo va a mover solo), cuando `itemtype` no es `mod`, y cuando el item no es
calificable.

Un item que desaparece del payload **no se borra**: se marca `last_seen_at`,
porque el profesor puede ocultarlo y volverlo a mostrar y el borrado haría que
reaparezca como "nota nueva". Un curso que responde `nopermissiontoviewgrades`
se registra como inaccesible y no se reintenta antes de 24 h, pero eso **no
invalida sus items ya guardados**.

## Calendario y fechas que vencen

`core_calendar_get_action_events_by_timesort` devuelve un objeto
`{events, firstid, lastid}`, **sin clave `warnings`**, ordenado ascendentemente
por `timesort`. En el recon se llamó con `timesortfrom = ahora - 30 días` y
`limitnum 50`, y devolvió 7 eventos, todos `component: 'mod_assign'`,
`modulename: 'assign'`, `eventtype: 'due'`, de 2 cursos.

**Esto no es un calendario, es una lista de pendientes.** Solo devuelve eventos
con acción pendiente (`isactionevent: true` en los 7). Lo ya entregado y lo
vencido no aparece. Una agenda unificada construida solo con esta llamada muestra
una lista que se vacía sola y nunca enseña historial.

### Raíz

| Campo | Tipo | Notas |
|---|---|---|
| `events[]` | array | ordenado ascendente por `timesort` |
| `firstid` | int | id del **primer evento de la página**, no el mínimo |
| `lastid` | int | id del último; es el cursor que se pasa como `aftereventid` |
| `warnings` | **ausente** | la clave no existe en esta función |

`firstid` y `lastid` no son un rango numérico: en el volcado `firstid > lastid`,
porque el orden es por `timesort` y los ids no son monótonos. Tratarlos como
cursores ordenados da resultados vacíos o duplicados.

### Evento

42 claves. Las que importan:

| Campo | Tipo | Observado |
|---|---|---|
| `id` | int | clave primaria estable del evento |
| `instance` | int | **pese al nombre, es el `cmid`**, no el id de instancia del módulo |
| `component` / `modulename` / `eventtype` | string | `mod_assign` / `assign` / `due`. **Las claves estables** |
| `name` | string | título guardado. En 5 de 7 sigue la plantilla `<activityname> está en fecha de entrega`; en 2 no. **No es derivable de `activityname`** |
| `activityname` | string | el título que debe pintar la UI |
| `activitystr` | string **localizado** | frase del tipo de fecha. Nunca comparar contra esta cadena |
| `description` | string HTML | **vacío en 6 de 7**; el que trae contenido son ~2500 caracteres con `h3`, `ul`, `ol`, `li`, `p`, `span`, `strong`, `br`, `a` |
| `descriptionformat` | int | `1` (HTML) en los 7, **incluso cuando `description` está vacía** |
| `location` / `formattedlocation` | string | cadena vacía en los 7 |
| `timestart` / `timesort` | epoch | idénticos en los 7 (todos `assign/due`) |
| `timeduration` | int | `0` en los 7: una fecha de entrega es un instante, no un bloque |
| `timeusermidnight` | epoch | **medianoche del día del evento en la zona del usuario**. Es la forma correcta de agrupar por día sin librería de zonas horarias |
| `timemodified` | epoch | 6 comparten dos timestamps (alta masiva al montar el curso); 1 fue modificado en las últimas 24 h |
| `visible` | int | `1` |
| `overdue` | boolean | `false` en los 7. Lo calcula el servidor |
| `isactionevent` | boolean | `true` en los 7: es el contrato de la función |
| `iscourseevent` / `iscategoryevent` | boolean | `false` en los 7 |
| `normalisedeventtype` | string | `course` |
| `normalisedeventtypetext` | string localizado | solo para pintar |
| `categoryid`, `groupid`, `userid`, `repeatid`, `eventcount`, `groupname` | **null explícito** | en los 7. No ausentes, no `0` |
| `canedit` / `candelete` | boolean | `false` en los 7 |
| `editurl` / `deleteurl` | string | **vienen pobladas aunque los permisos sean `false`**. `editurl` incluye `sesskey` |
| `url` | string | `mod/<modulename>/view.php?id=<cmid>`: de acá se extrae el cmid |
| `viewurl` | string | vista de **día del calendario**, no el enlace a la actividad |
| `formattedtime` | string | **HTML multilínea** con un `<a>` y un `<span data-timestamp>`, con saltos de línea e indentación adentro. No es una fecha formateada |
| `purpose` | string | `assessment`. Taxonomía de propósito, **no prioridad ni severidad** |
| `branded` | boolean | `false` |
| `subscription.displayeventsource` | boolean | `false`: no viene de una suscripción externa |
| `icon` | object | `{key, component, alttext, iconurl, iconclass, purpose}` |
| `action` | object | `{name, url, itemcount, actionable, showitemcount}` |
| `course` | object(21) | el curso entero embebido |

`icon.key` + `icon.component` es la única pareja estable. `icon.iconurl` lleva un
número de revisión del tema en la ruta: cambia cuando se bumpea el tema, así que
no sirve como clave de cache ni de comparación.

`action.actionable` significa **"se puede actuar ahora mismo"**, no "está
pendiente". Fue `true` solo en el evento más cercano y `false` en los 6 futuros.
Filtrar la agenda por `actionable` deja una lista de un solo item. (La causa
probable es que `allowsubmissionsfromdate` aún no llegó, pero eso no se puede
verificar con este volcado.)

`course` trae 21 claves, incluidas `fullname`, `shortname`, `idnumber`,
`coursecategory`, `viewurl`, `progress` (number, no `null` acá) y
`hasprogress`. Eso hace que la agenda se pueda pintar **sin unir con la tabla de
cursos**. Pero también trae `courseimage`.

### La trampa cara: `course.courseimage`

Es un data URI SVG en base64 que se repite íntegro en cada evento. **62.430 de
los 83.200 bytes compactos de la respuesta, el 75%.** Los datos útiles son unos
20 KB. Reglas: no persistirlo, no incluirlo en `payload_hash`, y calcular el
presupuesto de red sobre ~20 KB útiles, no sobre 88 KB.

### `instance` es el cmid

Dos pruebas duras, ninguna de ellas basada en rangos numéricos:

1. `events[].url` es `mod/assign/view.php?id=<instance>`, y ese `id` es un cmid.
   Coincidencia exacta en los 7.
2. `events[].editurl` es `course/mod.php?update=<instance>`, y ese componente
   recibe un cmid.

Es el quirk conocido del exporter de Moodle. **El join correcto es
`events[].instance = assignment.cmid`** (o `modules[].id`), nunca
`assignment.id`. Usarlo como `assign.id` no lanza error: simplemente no junta con
nada y el calendario queda huérfano. Y el join no se pudo verificar de punta a
punta, porque los 2 cursos que aparecen en el calendario no son ninguno de los 3
para los que se volcó `mod_assign_get_assignments`.

### Trampas del dominio

- La misma palabra cambia de significado entre funciones: en
  `core_course_get_contents`, `module.id` es el cmid y `module.instance` es el id
  de instancia; en el calendario, `instance` es el cmid. Un mapeador genérico
  compartido produce datos cruzados en silencio.
- **No hay señal de borrado.** Si un evento deja de venir puede ser porque
  entregaste, porque el profesor lo borró, o porque quedó fuera de la ventana
  pedida. Un sync que hace `DELETE` de lo no visto borra el historial.
- Todo lo legible por humanos viene en `es_mx`: `activitystr`,
  `normalisedeventtypetext`, `action.name`, `icon.alttext`. Las claves estables
  son `eventtype`, `modulename`, `component` y `normalisedeventtype`.
- Recortar el sufijo en español de `name` con una expresión regular para sacar el
  título rompe en el 29% de las filas y además se cae si la cuenta cambia de
  idioma. Usar `activityname`.
- `normalisedeventtype` es `course` pero `iscourseevent` es `false` en los mismos
  7 eventos. Son dos conceptos distintos (alcance contra origen) con nombres casi
  idénticos.
- Agrupar por día con `date(timesort,'unixepoch')` corre las entregas de las
  11:59 pm un día hacia adelante. Hay que agrupar con `timeusermidnight`.
- `editurl` trae un `sesskey`. Persistirlo o mandarlo a logs es filtrar una
  credencial de sesión, y además rota, así que la URL guardada queda inválida.
- Una UI que muestra el botón de editar porque la URL no está vacía lleva al
  estudiante a un 403.
- La inscripción arrastra materias de cuatrimestres viejos: barrer todos los
  cursos a ciegas son muchas llamadas para llenar 2. **El feed dice cuáles
  importan.**

### Funciones que faltan

| Ausente del recon | Por qué importa |
|---|---|
| `core_calendar_get_calendar_monthly_view` | expuesta, no llamada. Trae eventos **sin** acción pendiente |
| `core_calendar_get_calendar_upcoming_view` | expuesta, no llamada. Vista "próximos" con el lookahead del sitio (21 días) |
| `core_calendar_get_calendar_day_view` | expuesta, no llamada, **y no mencionada en ninguna lista previa** |
| `core_calendar_get_calendar_events` | expuesta, no llamada. Pide por rango y por lista de cursos, incluye eventos de usuario, grupo, curso, categoría y sitio |
| `core_calendar_get_calendar_event_by_id` | expuesta, no llamada. Refrescar un evento suelto sin repaginar |
| `core_calendar_get_action_events_by_course` / `_by_courses` | expuestas, no llamadas. Misma semántica acotada a cursos |
| `core_calendar_get_calendar_export_token` | expuesta, no llamada. Daría una URL iCal estable |
| `core_calendar_get_calendar_access_information` | expuesta, no llamada. Dice si el usuario puede crear eventos propios |
| `core_course_get_enrolled_courses_with_action_events_by_timeline_classification` | expuesta, no llamada. Devuelve los cursos que sí tienen eventos accionables |
| `core_calendar_get_timestamps` | **no existe** en las 438 |

### Esquema local

```sql
-- Una fila por evento del feed de acciones. No se guardan los campos
-- localizados re-derivables (formattedtime, normalisedeventtypetext) ni las
-- URLs con sesskey (editurl, deleteurl) ni course.courseimage.
CREATE TABLE IF NOT EXISTS pva_calendar_event (
  event_id             INTEGER PRIMARY KEY,
  user_id              INTEGER NOT NULL,
  course_id            INTEGER NOT NULL,
  cmid                 INTEGER,                      -- events[].instance: ES el course module id
  component            TEXT,                         -- 'mod_assign'
  modulename           TEXT,                         -- 'assign'
  eventtype            TEXT NOT NULL,                -- 'due'
  normalised_eventtype TEXT NOT NULL,                -- 'course'
  name                 TEXT NOT NULL,                -- cadena guardada, no derivable de activityname
  activityname         TEXT,                         -- el título que pinta la UI
  activitystr          TEXT,                         -- localizado, solo para pintar
  description_html     TEXT NOT NULL DEFAULT '',
  description_format   INTEGER NOT NULL DEFAULT 1,   -- 1 = HTML aun con description vacía
  location             TEXT NOT NULL DEFAULT '',
  timestart            INTEGER NOT NULL,
  timesort             INTEGER NOT NULL,             -- clave de orden y de paginación
  timeduration         INTEGER NOT NULL DEFAULT 0,
  timeusermidnight     INTEGER NOT NULL,             -- medianoche local del día del evento
  timemodified         INTEGER NOT NULL,
  visible              INTEGER NOT NULL DEFAULT 1,
  overdue              INTEGER NOT NULL DEFAULT 0,
  is_action_event      INTEGER NOT NULL DEFAULT 0,
  is_course_event      INTEGER NOT NULL DEFAULT 0,
  is_category_event    INTEGER NOT NULL DEFAULT 0,
  category_id          INTEGER,                      -- null en todo el volcado
  group_id             INTEGER,
  event_userid         INTEGER,                      -- events[].userid, renombrado para no chocar
  repeat_id            INTEGER,
  event_count          INTEGER,
  purpose              TEXT,                         -- 'assessment': taxonomía, no prioridad
  icon_key             TEXT,                         -- icon_key + icon_component es la pareja estable
  icon_component       TEXT,
  action_name          TEXT,                         -- localizado
  action_url           TEXT,
  action_itemcount     INTEGER,
  action_actionable    INTEGER NOT NULL DEFAULT 0,   -- "se puede actuar ahora", no "está pendiente"
  module_url           TEXT,                         -- events[].url
  calendar_view_url    TEXT,                         -- events[].viewurl, vista de día
  source               TEXT NOT NULL DEFAULT 'action_timesort',
  payload_hash         TEXT NOT NULL,                -- sin courseimage
  first_seen_at        INTEGER NOT NULL,
  last_seen_at         INTEGER NOT NULL,
  missing_since        INTEGER,                      -- desapareció del feed: ambiguo, nunca borrar en caliente
  -- El día local sale de la medianoche que Moodle ya calculó en la zona del
  -- usuario, sin necesidad de una base de zonas horarias en el cliente.
  local_day TEXT GENERATED ALWAYS AS (date(timeusermidnight + 43200, 'unixepoch')) VIRTUAL
);
CREATE INDEX IF NOT EXISTS idx_pva_event_timesort  ON pva_calendar_event(timesort);
CREATE INDEX IF NOT EXISTS idx_pva_event_course    ON pva_calendar_event(course_id, timesort);
CREATE INDEX IF NOT EXISTS idx_pva_event_cmid      ON pva_calendar_event(cmid);
CREATE INDEX IF NOT EXISTS idx_pva_event_local_day ON pva_calendar_event(local_day);
CREATE INDEX IF NOT EXISTS idx_pva_event_pendiente ON pva_calendar_event(missing_since, timesort);
```

Ausencia, nunca borrado: un evento que desaparece se marca `missing_since` y se
conserva. Se resuelve consultando `mod_assign_get_submission_status` por cmid, y
solo se purga cuando la corrida cubrió la ventana completa **y** el evento cae
dentro de esa ventana **y** el estado de entrega lo confirma.

## Foros, anuncios y notificaciones

Tres fuentes separadas, que no se solapan:
`mod_forum_get_forums_by_courses(courseids[])` (arreglo pelado),
`message_popup_get_popup_notifications(useridto)` (`{notifications[],
unreadcount}`) y `core_message_get_conversations(userid)` (`{conversations[]}`).

Muestra: 3 cursos con 1, 1 y 0 foros; 1 notificación en la campanita; varias
conversaciones, todas `type: 1`.

### Foro

34 claves. Las que deciden algo:

| Campo | Tipo | Notas |
|---|---|---|
| `id` | int | instancia del foro. **No es el cmid** |
| `cmid` | int | el id de `/mod/forum/view.php?id=`, y lo único que empata con `core_course_get_contents[].modules[].id` |
| `course` | int | curso |
| `type` | string enum | **el único discriminador confiable**. Vistos `news` (foro de avisos del profesor) y `general`. `eachuser`, `single`, `qanda`, `blog` son de la definición de Moodle, no vistos |
| `name` | string | editable por el profesor y dependiente del idioma. **No sirve para clasificar** |
| `intro` / `introformat` | HTML / int | descripción, formato `1` |
| `introfiles[]` | array | vacío en ambos foros; forma interna sin confirmar |
| `lang` | string | cadena vacía (heredar) |
| `duedate` / `cutoffdate` | epoch | `0` en el foro `news`; en el `general` **idénticos entre sí**: no asumir `cutoff > due` |
| `assessed` | int | **`0` en ambos**: valoraciones apagadas |
| `assesstimestart` / `assesstimefinish` | epoch | `0` |
| `scale` | int | `0` en el `news`, `100` en el `general`. **Con `assessed=0` es inerte** |
| `grade_forum` / `grade_forum_notify` | int | `0` en ambos |
| `forcesubscribe` | int enum | `1` en el `news`, `0` en el `general`. Señal secundaria de foro de anuncios y la razón por la que un anuncio llega a la campanita |
| `trackingtype` | int enum | `1` (opcional) en ambos |
| `istracked` | boolean | **`false` en ambos**: no hay conteo de no leídos por foro disponible |
| `rsstype` / `rssarticles` | int | `0`: no hay atajo por RSS |
| `timemodified` | epoch | **modificación de la CONFIGURACIÓN**, no del último mensaje |
| `numdiscussions` | int | **el contador barato** para detectar un anuncio nuevo sin bajar contenido |
| `cancreatediscussions` | boolean | **`false` en los dos**: no discrimina anuncios pese a ser el candidato obvio |
| `maxbytes`, `maxattachments`, `warnafter`, `blockafter`, `blockperiod`, `lockdiscussionafter`, `completiondiscussions`, `completionreplies`, `completionposts` | int | `0` salvo `maxattachments` |

**El foro de anuncios no se puede reconocer desde `core_course_get_contents`**: el
módulo trae `modname: 'forum'` y `purpose: 'collaboration'` idénticos para el
`news` y para el `general`, y no trae `type`. Hay que llamar
`mod_forum_get_forums_by_courses` sí o sí.

Y **el foro de anuncios es opcional y frecuentemente no existe**: de los 3 cursos
sondeados, uno devolvió `[]`, otro solo un `general`, y solo uno tenía el `news`.
Una UI que asume "todo curso tiene su tablón" queda vacía en la mayoría.

**`scale > 0` no significa foro calificable.** Con `assessed = 0` y
`grade_forum = 0`, la escala está inerte, y el libro de calificaciones de ese
curso no tiene ningún item de foro. Lo que sí se pierde si solo se lee
`mod_assign_get_assignments` es **la fecha**: ese foro `general` trae `duedate` y
`cutoffdate` y es una entrega con fecha que `mod_assign` no reporta. El criterio
correcto es `duedate > 0`, no `scale`.

### Notificación de la campanita

`{notifications[], unreadcount}`. `unreadcount` es el total de no leídas, **no el
largo del arreglo devuelto**.

| Campo | Tipo | Observado |
|---|---|---|
| `id` | int | llave natural para insertar sin duplicar |
| `useridfrom` | int | **`-10`**, el pseudo usuario de sistema. **Puede ser negativo: no es FK a usuarios** |
| `useridto` | int | siempre el usuario autenticado |
| `component` | string enum | `mod_assign`. Junto con `eventtype` es la llave de enrutamiento |
| `eventtype` | string enum | `assign_due_soon`, que es **recordatorio de vencimiento, no creación de tarea** |
| `subject` | string localizado | con la fecha escrita en prosa. No parsear la fecha de acá |
| `shortenedsubject` | string | idéntico a `subject` en el caso visto: no asumir que es más corto |
| `text` | string **HTML** | cuerpo corto envuelto en `<p>`, pese al nombre |
| `fullmessage` | string plano | con saludo por nombre, nombre del curso, y un pie `Links: ------ [1] <url>`, con `&` escapado como `&amp;` |
| `fullmessageformat` | int | `1` |
| `fullmessagehtml` | string HTML | con `<strong>` y el enlace ya armado |
| `smallmessage` | string localizado | igual a `subject` en el caso visto |
| `contexturl` | URL | deep link al módulo. Trae el **cmid** en `?id=`, con `&` **sin escapar** |
| `contexturlname` | string | el título más limpio disponible para el aviso |
| `timecreated` | epoch | la marca de agua del sync |
| `timecreatedpretty` | string localizado | relativo. **Se pudre en cache**: no guardarlo ni parsearlo |
| `read` / `timeread` | boolean / int \| null | **estado compartido** con el portal y la app oficial |
| `deleted` | boolean | `false` |
| `iconurl` | URL | icono del componente servido por el tema |
| `customdata` | string JSON | para `assign_due_soon`: `{assignmentid, duedate}` |
| `courseid` | **no existe** | la notificación no dice a qué curso pertenece |

Una misma notificación trae **dos ids distintos del mismo objeto**:
`contexturl` lleva el **cmid** y `customdata.assignmentid` lleva el **id de
instancia**. Confundirlos hace join contra la fila equivocada.

El curso hay que resolverlo por cmid, y **puede fallar legítimamente**: en el
volcado el cmid de la única notificación no pertenece a ninguno de los 3 cursos
sincronizados. El aviso igual se debe mostrar, con `contexturlname`.

Que las notificaciones vengan ordenadas de más reciente a más antigua es
**supuesto**: con una sola notificación el orden no es observable. El sync no
depende de la posición porque usa `MAX(timecreated)` como marca de agua.

### Conversaciones

| Campo | Tipo | Observado |
|---|---|---|
| `id`, `type` | int | `type: 1` (individual) en todas. `2` grupal y `3` propia son convención de Moodle |
| `name` / `subname` / `imageurl` | string / null / null | cadena vacía y `null` en individuales: el título se arma desde `members[]` |
| `membercount` | int | `2` mientras `members[]` trae **1**: el arreglo **excluye al usuario autenticado** |
| `isread` | boolean | `true` en todas |
| `unreadcount` | int \| **null** | **`null`, no `0`**, cuando está todo leído |
| `ismuted` / `isfavourite` / `candeletemessagesforallusers` / `cansendmessagetoconversation` | boolean | |
| `members[]` | array(1) | id, `fullname`, `profileurl`, avatares, `isonline` (volátil), `isblocked`, `iscontact`, `canmessage`, `contactrequests[]` (vacío) |
| `messages[]` | array(1) | **solo el último mensaje, no el hilo**, y sin `subject`: `{id, useridfrom, text (HTML), timecreated}` |

Los mensajes directos **no aparecen** en la campanita: viven en otro endpoint.
Eso se deduce de la separación de endpoints de Moodle 3.6+, no del volcado.

### Qué disparo tiene cada aviso

| Aviso | Cómo se detecta |
|---|---|
| anuncio del profesor | **híbrido**: disparo rápido por notificación con `component = 'mod_forum'` cuyo cmid resuelva a un foro con `type = 'news'`, respaldo obligatorio por `numdiscussions`. El respaldo es obligatorio porque la notificación depende de las preferencias del usuario y de `forcesubscribe` |
| tarea nueva | **solo diff**. No existe notificación de creación en Moodle; el único `eventtype` visto es `assign_due_soon`. Diff contra `mod_assign_get_assignments` (id de instancia nuevo), confirmado contra `core_course_get_contents` (cmid nuevo con `modname = 'assign'`) |
| nota publicada | diff sobre `gradereport_user_get_grade_items`, con disparo oportunista si llega una notificación de `mod_assign` con `eventtype` distinto de `assign_due_soon` |
| tarea por vencer | directo de la campanita, `eventtype = 'assign_due_soon'`, sin diff |

**Silencio exigido.** Foros que no sean `type = 'news'` y mensajes directos no
generan aviso nunca. El filtro **no puede ser** "excluir `component = mod_forum`",
porque el anuncio del profesor llega por ese mismo `component`: hay que resolver
el cmid de la notificación contra la tabla de foros y mirar `type`.

**Idempotencia.** `read` y `timeread` son estado compartido, así que el ledger
local (`pva_alert.delivered_at`) es lo único que decide si un aviso ya se mostró.
La llave de deduplicación es el objeto de Moodle (`assign:<instanceid>`,
`discussion:<id>`), no el id de la notificación, para que un recordatorio
repetido y un diff no disparen dos veces.

### Trampas del dominio

- Clasificar el foro por nombre (`Avisos`, `Announcements`) se rompe: es una
  cadena editable y dependiente del idioma.
- `forum.timemodified` es la fecha de la configuración: el foro de anuncios visto
  tenía `numdiscussions = 0` y `timemodified` no cero. Usarlo como "último
  anuncio" inventa actividad.
- `numdiscussions` solo sube con discusiones nuevas: una edición del profesor o
  una respuesta dentro de un anuncio existente **no lo mueve**. Detecta anuncios
  nuevos, no anuncios cambiados.
- `istracked = false` y `activitybadge` vacío: **no hay contador de no leídos por
  foro** en esta instancia.
- El ampersand viene codificado distinto en campos de la misma notificación:
  `contexturl` trae `&` crudo y `fullmessage` trae `&amp;`.
- `unreadcount` de la campanita puede quedar idéntico si llega una nueva y se lee
  otra. Condicionar el pull únicamente a que ese número cambie salta
  notificaciones.
- `read = false` como "todavía no se lo avisé" pierde avisos: si el estudiante
  abre la campanita en el navegador, `read` pasa a `true` sin que la app lo sepa.
- `fullmessage` no es prosa limpia: termina con `Links:\n------\n[1] <url>`.
- `fullmessage` y `subject` incrustan el nombre de pila y el nombre del curso;
  `messages[].text` incrusta conversaciones privadas. **Persistirlos crudos mete
  datos personales en la base local sin necesidad.**
- `core_course_get_updates_since` devolvió `{instances: [], warnings: []}` en los
  3 cursos con `since = ahora - 14 días`. Construir el sync de avisos encima de
  esa función, sin verificarla con un `since` viejo, deja la app muda.

### Funciones que faltan

| Ausente | Por qué importa |
|---|---|
| `mod_forum_get_forum_discussions` | declarada, **no sondeada**. Es el hueco central: sin ella no hay contenido de anuncio, solo el contador |
| `mod_forum_get_discussion_posts` | declarada, no sondeada. Necesaria si un anuncio tiene respuestas |
| `message_popup_get_unread_popup_notification_count` | declarada, no sondeada. Sondeo barato entre pulls completos |
| `core_message_get_user_notification_preferences` | declarada, no sondeada. **Decide si la campanita es un disparador confiable**: si el usuario apagó el canal popup, esos avisos nunca llegan y hay que caer a diff sí o sí |
| `core_message_get_unread_conversation_counts` | declarada, no sondeada. Alternativa barata a bajar la bandeja |
| `mod_forum_get_forum_access_information` | declarada, no sondeada. Diría si el usuario puede publicar, mejor que `cancreatediscussions`, que resultó no discriminar |
| `core_message_mark_notification_read` | declarada, no sondeada. **Muta estado remoto compartido**: usarla solo con permiso explícito |

### Esquema local

```sql
CREATE TABLE IF NOT EXISTS pva_forum (
  forum_id               INTEGER PRIMARY KEY,          -- instancia del foro
  user_id                INTEGER NOT NULL,
  course_id              INTEGER NOT NULL,
  cmid                   INTEGER NOT NULL UNIQUE,
  type                   TEXT    NOT NULL,             -- 'news' | 'general' | ...
  is_announcements       INTEGER GENERATED ALWAYS AS (type = 'news') VIRTUAL,
  name                   TEXT    NOT NULL,             -- rótulo, nunca criterio
  intro_html             TEXT,
  forcesubscribe         INTEGER NOT NULL DEFAULT 0,
  trackingtype           INTEGER NOT NULL DEFAULT 0,
  is_tracked             INTEGER NOT NULL DEFAULT 0,
  can_create_discussions INTEGER NOT NULL DEFAULT 0,   -- NO discrimina anuncios
  num_discussions        INTEGER NOT NULL DEFAULT 0,   -- guarda de delta para anuncios
  duedate                INTEGER NOT NULL DEFAULT 0,   -- 0 = sin fecha; >0 = entrega que mod_assign no reporta
  cutoffdate             INTEGER NOT NULL DEFAULT 0,   -- puede ser igual a duedate
  scale                  INTEGER NOT NULL DEFAULT 0,   -- escala de valoraciones; inerte si assessed = 0
  assessed               INTEGER NOT NULL DEFAULT 0,   -- != 0 es lo que hace calificable al foro
  grade_forum            INTEGER NOT NULL DEFAULT 0,
  config_modified_at     INTEGER NOT NULL DEFAULT 0,   -- timemodified: CONFIG, no último post
  fetched_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pva_forum_course     ON pva_forum (user_id, course_id);
CREATE INDEX IF NOT EXISTS idx_pva_forum_anuncios   ON pva_forum (user_id, course_id) WHERE type = 'news';
CREATE INDEX IF NOT EXISTS idx_pva_forum_entregable ON pva_forum (duedate) WHERE duedate > 0;

-- Anuncios. Fuente prevista: mod_forum_get_forum_discussions, NO sondeada.
-- Columnas conservadoras a propósito hasta ver un volcado real.
CREATE TABLE IF NOT EXISTS pva_announcement (
  discussion_id INTEGER PRIMARY KEY,
  forum_id      INTEGER NOT NULL REFERENCES pva_forum(forum_id) ON DELETE CASCADE,
  course_id     INTEGER NOT NULL,
  subject       TEXT    NOT NULL,
  message_html  TEXT,
  pinned        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  modified_at   INTEGER NOT NULL,             -- marca de agua real del foro
  fetched_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pva_announcement_curso
  ON pva_announcement (course_id, modified_at DESC);

-- Campanita. Insert-only con ON CONFLICT(id) DO UPDATE de read/timeread/deleted.
CREATE TABLE IF NOT EXISTS pva_notification (
  notification_id    INTEGER PRIMARY KEY,     -- id de Moodle, estable
  user_id            INTEGER NOT NULL,
  userid_from        INTEGER NOT NULL,        -- puede ser NEGATIVO (sistema). Sin FK
  component          TEXT    NOT NULL,        -- 'mod_assign', 'mod_forum', ...
  eventtype          TEXT    NOT NULL,        -- 'assign_due_soon', ...
  subject            TEXT    NOT NULL,
  small_message      TEXT,
  full_message_html  TEXT,
  contexturl         TEXT,
  contexturl_name    TEXT,
  cmid               INTEGER,                 -- derivado de contexturl ?id=<cmid>
  course_id          INTEGER,                 -- NULL hasta resolver cmid; puede quedar NULL
  customdata_raw     TEXT,                    -- string JSON crudo, puede venir NULL o ''
  instance_id        INTEGER,                 -- customdata.assignmentid: NO es el cmid
  customdata_duedate INTEGER,
  icon_url           TEXT,
  created_at         INTEGER NOT NULL,        -- timecreated, marca de agua del pull
  read_remote        INTEGER NOT NULL DEFAULT 0, -- estado COMPARTIDO con el portal
  read_at_remote     INTEGER,
  deleted_remote     INTEGER NOT NULL DEFAULT 0,
  fetched_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pva_notif_ruteo   ON pva_notification (component, eventtype, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pva_notif_cmid    ON pva_notification (cmid) WHERE cmid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pva_notif_sinruta ON pva_notification (notification_id) WHERE course_id IS NULL;

-- Ledger local de avisos. Única verdad sobre "esto ya se le mostró al usuario":
-- read_remote no sirve porque el portal web lo cambia por su cuenta.
CREATE TABLE IF NOT EXISTS pva_alert (
  alert_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL,
  kind            TEXT    NOT NULL CHECK (kind IN ('tarea_nueva','tarea_por_vencer','nota_publicada','anuncio')),
  source          TEXT    NOT NULL CHECK (source IN ('notification','diff')),
  subject_key     TEXT    NOT NULL,           -- 'assign:<instanceid>' | 'discussion:<id>' | 'gradeitem:<id>'
  notification_id INTEGER REFERENCES pva_notification(notification_id) ON DELETE SET NULL,
  course_id       INTEGER,
  title           TEXT    NOT NULL,
  url             TEXT,
  occurred_at     INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  delivered_at    INTEGER,
  UNIQUE (user_id, kind, subject_key)          -- dedup por objeto de Moodle, no por notificación
);
CREATE INDEX IF NOT EXISTS idx_pva_alert_pendientes
  ON pva_alert (occurred_at DESC) WHERE delivered_at IS NULL;

-- Bandeja de mensajes directos: metadatos, sin cuerpos. No genera avisos por
-- decisión de producto, y no guardar messages[].text es higiene de privacidad.
CREATE TABLE IF NOT EXISTS pva_conversation (
  conversation_id   INTEGER PRIMARY KEY,
  user_id           INTEGER NOT NULL,
  type              INTEGER NOT NULL,         -- 1 individual (único visto)
  member_count      INTEGER NOT NULL,         -- incluye al usuario; members[] no
  is_read           INTEGER NOT NULL DEFAULT 1,
  unread_count      INTEGER,                  -- NULL cuando está leída, no 0
  is_muted          INTEGER NOT NULL DEFAULT 0,
  is_favourite      INTEGER NOT NULL DEFAULT 0,
  last_message_at   INTEGER,
  last_message_from INTEGER,
  fetched_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pva_conversation_reciente
  ON pva_conversation (last_message_at DESC);
```

## Archivos y documentos

No hay una función de archivos: hay **cuatro fuentes con cuatro formas
distintas** del mismo descriptor de fichero, y un endpoint HTTP fuera del
servicio REST.

| Fuente | Claves por fichero | Particularidades |
|---|---:|---|
| `core_course_get_contents[].modules[].contents[]` | 13 | trae `type`, `timecreated`, `sortorder`, `userid`, `author`, `license`; **la URL ya trae `?forcedownload=1`** |
| `mod_assign_get_assignments[].introattachments[]` | 8 | sin `type`, `timecreated`, `sortorder`, `author`, `license`; **con `icon`**; sin query |
| `mod_assign_get_submission_status` (entrega y feedback) | 8 | misma forma que la anterior; sin query |
| `core_enrol_get_users_courses[].overviewfiles[]` | 6 | `filename`, `filepath`, `filesize`, `fileurl`, `timemodified`, `mimetype`; sin query, **sin itemid en la ruta** |

Un tipo único compartido tiene que ser la **unión con casi todo opcional**.

### `contents[]` de un módulo

Presente en 95 de 131 módulos. Ausente por completo en `label`, `assign`,
`forum` y `glossary`. Presente pero vacío en 3 (1 `url` y 2 `folder`).

| Campo | `resource` / `folder` | `page` | `url` |
|---|---|---|---|
| `type` | `file` | `file` | `url` |
| `filename` | nombre real | `index.html` | **título del enlace**, no un archivo |
| `filepath` | `/` | `/` | **null** |
| `filesize` | bytes reales | **`0` con cuerpo real** | `0` |
| `fileurl` | pluginfile con `?forcedownload=1` | idem | URL externa, **sin token** |
| `mimetype` | presente | **clave ausente** | **clave ausente** |
| `isexternalfile` | `false` | **clave ausente** | **clave ausente** |
| `timemodified` | siempre presente | presente | presente |
| `timecreated` | presente | **null** | **null** |
| `userid` / `author` / `license` | presentes | **null** | **null** |
| `sortorder` | int (`1` o `0`) | **int `1`** | **null** |

Reparto: 54 `file` (40 `resource`, 11 `page`, 3 `folder`) y 42 `url`. Las claves
`mimetype` e `isexternalfile` faltan en **53 de 96**. `timecreated`, `userid`,
`author` y `license` son `null` en **53 de 96** (los 42 `url` **y** los 11
`page`). Es decir: **ser `type: 'file'` no garantiza ninguno de esos cuatro
campos.**

`contentsinfo`, presente exactamente donde existe `contents`:

| Campo | Notas |
|---|---|
| `filescount` | `0` cuando el módulo está vacío. Coincide con `len(contents)` |
| `filessize` | **`0` en todos los `page` y `url` aunque `filescount` sea 1**. Cota inferior, jamás presupuesto de descarga |
| `lastmodified` | epoch del fichero más reciente. **El mejor watermark por módulo** para un delta local. `0` cuando `filescount` es 0 |
| `mimetypes[]` | vacío en `url` y `page` aunque `filescount` sea 1 |
| `repositorytype` | `''` en 92 (repositorio local), **clave ausente** en los 3 con `filescount = 0` |

### Las dos plantillas de ruta de pluginfile

```text
5 segmentos: /webservice/pluginfile.php/{contextid}/{component}/{filearea}/{itemid}/{filename}
4 segmentos: /webservice/pluginfile.php/{contextid}/{component}/{filearea}/{filename}
```

| Plantilla | Dónde |
|---|---|
| 5 segmentos | `mod_resource/content/{revision}` (40), `mod_folder/content/{n}` (3), `mod_assign/introattachment/{n}` (8), `assignsubmission_file/submission_files/{n}`, `assignfeedback_editpdf/{area}/{n}` |
| 4 segmentos, **sin itemid** | `mod_page/content/index.html` (11), `course/overviewfiles/{filename}` (3) |

Un parse posicional que asuma `itemid` mete el filename en la columna
equivocada. Y en `mod_resource` el cuarto segmento es un **número de revisión**,
no un itemid: cambia cuando el profesor reemplaza el fichero. Si la identidad de
la fila es la URL, cada reemplazo crea un duplicado en vez de actualizar. La
identidad tiene que ser `(course_id, cmid, component, area, filepath,
filename)`.

### Descarga, verificada en vivo

| Aspecto | Resultado |
|---|---|
| parámetro del token | **`token`**, no `wstoken` |
| concatenación | 54 URLs **ya traen query** (`?forcedownload=1`); **33 no traen ninguna** (8 introattachments + 22 de submission_status + 3 overviewfiles). Concatenar siempre con `&` rompe esas 33 |
| respuesta OK | 200 con `Content-Type` real, `Content-Disposition` con el filename |
| `ETag` | **fuerte, 40 hex (sha1 del contenido)**. `If-None-Match` devuelve 304. Es la única señal de cambio fiable |
| `Last-Modified` | válido; `If-Modified-Since` devuelve 304 |
| `Accept-Ranges: bytes` | `Range` devuelve 206 real: se puede reanudar |
| `Cache-Control` | `private, max-age=21600` (6 h) |
| `Content-Length` | **no existe**: la respuesta va chunked. No se puede presupuestar con un HEAD ni verificar la descarga contra el header |
| ruta alternativa | `{SITEURL}/tokenpluginfile.php/{userprivateaccesskey}/{resto}` devuelve 200 con el mismo ETag, **sin token en la query**. Evita que el `wstoken` quede en historiales o logs de proxy |

El último segmento de `fileurl` viene **percent-encoded** (36 de 54 casos, sobre
todo espacios) mientras `filename` viene decodificado. Nunca derivar el nombre de
disco parseando la URL, ni re-encodear la URL: el path ya viene listo y volver a
pasarlo por un encoder rompe los `%20`.

### Volumen medido

Sobre 3 cursos: 131 módulos, 96 entradas de `contents`, 54 ficheros y 42 enlaces
externos.

| Métrica | Valor |
|---|---|
| total | 74.1 MiB (77.7 MB) en 54 ficheros |
| el PDF más grande | 45.3 MiB, **el 61% de todos los bytes** |
| sin él | 28.7 MiB en 53 ficheros |
| mediana / p75 / p90 | 103 KB / 403 KB / 864 KB |
| reparto | 25 bajo 100 KB, 25 entre 100 KB y 1 MB, 2 entre 1 y 10 MB, 2 sobre 10 MB |
| uno de los 3 cursos | **cero archivos** |

Aparte, 3 tareas muestreadas: 30 ficheros y 25.3 MiB, repartidos en 9.21 MiB de
enunciados, 11.45 MiB de entregas propias y 4.64 MiB de corrección. Ese último
bloque son **0.72 MiB de PDF (`combined`) más 3.91 MiB de PNG en dos áreas
duplicadas byte a byte (`pages` y `readonlypages`) más 4.5 KB de `stamps`**.
Bajar las dos áreas de PNG es descargar dos veces lo mismo.

Extrapolando a un semestre de 6 materias activas: del orden de 160 a 200
ficheros y entre 100 y 250 MB, con la varianza dominada por uno o dos PDF
gigantes. La extrapolación sale de 2 cursos con archivos sobre el total
matriculado, así que es una estimación, no una medición.

### Extracción a texto

| Tipo | Ficheros | Bytes | Extracción |
|---|---:|---|---|
| `application/pdf` | 32 | 71.0 MiB | directa |
| `.wordprocessingml.document` | 4 | 0.15 MiB | directa |
| `.presentationml.presentation` | 2 | 1.66 MiB | directa |
| `application/msword` (binario viejo) | 1 | 0.04 MiB | necesita `antiword` o LibreOffice; caso borde |
| `image/jpeg` | 4 | 1.23 MiB | solo con OCR, no vale la pena por defecto |
| `index.html` de `mod_page` | 11 | **58.5 KB** | **el de mayor valor por byte** |

Los 11 `index.html` llegan **sin `mimetype` y con `filesize: 0`**, y sin embargo
pesan entre 407 B y 29.5 KB (media 5.3 KB), `text/html;charset=UTF-8`, y el
cuerpo es un **fragmento** (`<div class="no-overflow">...`), no un documento
completo. Un planificador que salte los ceros pierde todo el contenido de las
páginas.

Cubriendo pdf + ooxml + html de páginas se indexa el 100% del contenido textual
**de los ficheros de curso**. Las correcciones rasterizadas (`pages`) y los jpeg
quedan fuera sin OCR.

### `core_course_get_updates_since`: el delta de servidor

En el volcado devolvió `{instances: [], warnings: []}` en los 3 cursos con
`since = ahora - 14 días`, lo cual era correcto (el contenido más nuevo tiene 45
días) pero **indistinguible de una función capada**. Re-ejecutada en vivo con
`since = 0` sí devuelve datos. Todo lo que sigue es **prueba en vivo, fuera del
volcado**:

| Campo | Tipo | Notas |
|---|---|---|
| `instances[].contextlevel` | string | `module` en las 130 instancias de las dos llamadas |
| `instances[].id` | int | **es el `cmid`**, no el `instance`. Conjunto idéntico al de `modules[].id` de `get_contents` |
| `instances[].updates[].name` | string enum | `configuration`, `contentfiles`, `introfiles`, `introattachmentfiles`, `completion`, `gradeitems`, `submissions`, `grades`, `entries`, `discussions` |
| `instances[].updates[].timeupdated` | epoch \| **ausente** | **solo en `name = 'configuration'`** |
| `instances[].updates[].itemids` | int[] \| ausente | en `contentfiles`, `introfiles`, `introattachmentfiles`, `gradeitems`, `submissions`, `grades`, `entries`, `discussions`. **Ausente en `configuration` y en `completion`** |

Esto tiene una consecuencia de diseño que no es obvia: **el update que trae la
fecha es el único que hay que ignorar como señal, y los updates que sirven de
señal no traen ninguna fecha.** `configuration` aparece en el 100% de los
módulos, así que tratarlo como "algo cambió" anula por completo el delta; pero es
la única fuente de `timeupdated`. El cursor no se puede derivar del payload de
los updates de archivo: se avanza con el reloj de la petición (menos un margen de
60 s) o con el `timeupdated` de `configuration` del mismo cmid como cota.

`since = 0` sirve además de backfill: devuelve el catálogo completo de módulos
con actividad, lo que permite priorizar qué cursos abrir primero sin bajar los
contents de la matrícula entera.

### Área de archivos privados

`core_user_get_private_files_info()` responde ok con `filecount`,
`foldercount`, `filesize`, `filesizewithoutreferences` (la diferencia con
`filesize` revela cuánto es alias) y `warnings`. **Los cuatro contadores en cero
en el volcado**: cualquier feature construida encima se probaría solo contra
ceros. Y `userquota` (100 MB) es el techo de esta área, cinco veces menor que
`usermaxuploadfilesize`.

### Trampas del dominio

- Tres formas de recibir HTTP 200 con basura al descargar (ver "El sobre y los
  errores"). Validar `Content-Type` antes de escribir.
- `filesize: 0` **no significa fichero vacío**.
- `contentsinfo.filessize` también miente: vale `0` en todos los `page` y `url`.
- El campo `icon` de la forma de assign **no es una URL**: son claves de pix de
  Moodle (`f/pdf`, `f/image`, `f/document`). No es descargable, y quien quiera
  mostrar el icono tiene que construir la URL del tema a partir de esa clave.
- **Hay colisión de nombres**: 44 nombres distintos para 54 ficheros dentro de la
  muestra. Guardar en disco por `filename` pisa contenido. La ruta local tiene que
  llevar `course_id/cmid` o el sha256.
- Un módulo puede tener varios ficheros con el mismo `contextid`: un `resource`
  trajo 3. Asumir un fichero por módulo pierde contenido silenciosamente.
- `repositorytype` llega `''` cuando el fichero es local y **la clave desaparece**
  cuando el módulo no tiene ficheros. En JavaScript `undefined` y `''` son ambos
  falsy y la distinción se pierde; el bug real es el `KeyError` al acceder sin
  guardia.
- `timemodified` es la fecha de la **restauración del curso**, no la de autoría:
  29 de los 54 ficheros comparten el mismo minuto. Después de un rollover de
  semestre, un delta basado en `timemodified` redescarga el curso entero. **El
  ETag es la única señal fiable de que el contenido cambió.**
- `fileurl` de un `content` con `type = 'url'` es el enlace externo (17 hosts
  distintos en la muestra), sin token y sin relación con pluginfile: mandarle el
  token es **filtrar la credencial a un tercero**.

### Funciones que faltan

| Ausente del recon | Por qué importa |
|---|---|
| `mod_page_get_pages_by_courses` | **crítica**: hoy el cuerpo de una página solo se obtiene bajando el `index.html` |
| `mod_folder_get_folders_by_courses` | única manera de ver subcarpetas; `get_contents` las aplana en `filepath` |
| `mod_resource_get_resources_by_courses` | daría `contentfiles[]` con revisión sin recorrer todo el curso |
| `mod_url_get_urls_by_courses` | agregaría `display` y parámetros |
| `core_files_get_files(contextid, component, filearea, itemid, filepath, filename)` | listado genérico de un filearea, para paginar una carpeta grande |
| `core_course_check_updates(courseid, tocheck)` | versión dirigida de `updates_since`, con `since` por módulo |
| `core_course_get_course_module(cmid)` | refresco de un solo módulo |
| `mod_book_*`, `mod_lesson_get_page_data`, `mod_wiki_get_subwiki_files`, `core_h5p_get_trusted_h5p_file` | fuentes de archivo de modname que no aparecieron en la muestra |
| `mod_data_*` (11 funciones) y `mod_workshop_*` | **están expuestas** en el catálogo; lo que falta es haberlas llamado y que aparezca una instancia de esos módulos |

### Esquema local

```sql
-- Un archivo tal como lo describe la PVA. La identidad NO es la URL: en
-- mod_resource la ruta lleva un número de revisión que cambia cuando el
-- profesor reemplaza el fichero, y un UNIQUE sobre la URL crearía una fila
-- nueva en cada reemplazo en vez de actualizar la existente.
CREATE TABLE IF NOT EXISTS pva_file (
  file_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL,
  course_id      INTEGER NOT NULL,
  cmid           INTEGER NOT NULL DEFAULT 0,   -- 0 para overviewfiles del curso
  context_id     INTEGER NOT NULL,
  component      TEXT    NOT NULL,             -- mod_resource|mod_page|mod_folder|mod_assign|assignsubmission_file|assignfeedback_editpdf|course
  area           TEXT    NOT NULL,             -- content|introattachment|submission_files|combined|overviewfiles|...
  item_id        INTEGER,                      -- NULL en mod_page/content y course/overviewfiles: la URL corta no lo trae
  revision       INTEGER,                      -- 4o segmento en mod_resource; cambia al reemplazar el fichero
  filepath       TEXT    NOT NULL DEFAULT '/',
  filename       TEXT    NOT NULL,             -- decodificado; el último segmento de fileurl viene percent-encoded
  fileurl        TEXT    NOT NULL,             -- sin token y sin query
  force_download INTEGER NOT NULL DEFAULT 0,   -- 1 si la fileurl original ya traía query
  filesize       INTEGER NOT NULL DEFAULT 0,   -- DECLARADO. 0 no significa vacío: mod_page reporta 0 con cuerpo real
  mimetype       TEXT,                         -- NULL en mod_page y en type='url'
  isexternalfile INTEGER,                      -- NULL cuando la función de origen no trae la clave
  timecreated    INTEGER,                      -- solo core_course_get_contents lo trae, y no siempre
  timemodified   INTEGER NOT NULL,
  sortorder      INTEGER,
  license        TEXT,
  source_fn      TEXT    NOT NULL,             -- wsfunction que lo trajo
  seen_at        INTEGER NOT NULL,
  deleted_at     INTEGER,                      -- soft delete; el profesor puede reponerlo
  UNIQUE (course_id, cmid, component, area, filepath, filename)
);
-- contents[].author y contents[].userid NO se guardan: son nombres e ids de
-- profesores reales y ninguna pantalla los usa. Si algún día hace falta
-- mostrar autoría, se agrega la columna con la justificación en el mismo commit.
CREATE INDEX IF NOT EXISTS idx_pva_file_course ON pva_file (user_id, course_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_pva_file_cmid   ON pva_file (cmid);
CREATE INDEX IF NOT EXISTS idx_pva_file_mime   ON pva_file (mimetype);

-- Estado del blob en disco, separado de la metadata porque caduca distinto: la
-- metadata por TTL, el blob solo cuando el ETag cambia.
CREATE TABLE IF NOT EXISTS pva_file_blob (
  file_id       INTEGER PRIMARY KEY REFERENCES pva_file(file_id) ON DELETE CASCADE,
  local_path    TEXT    NOT NULL,              -- <cache>/<course_id>/<cmid>/<sha256[:2]>/<sha256>
  bytes         INTEGER NOT NULL,              -- reales, contados al escribir; no filesize
  sha256        TEXT    NOT NULL,
  etag          TEXT,                          -- tal cual, con comillas, para If-None-Match
  last_modified TEXT,                          -- string HTTP tal cual, para If-Modified-Since
  content_type  TEXT,                          -- el real; manda sobre pva_file.mimetype
  downloaded_at INTEGER NOT NULL,
  verified_at   INTEGER NOT NULL,              -- último 304 o 200
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT
);

-- Texto extraído. Un archivo puede fallar la extracción sin invalidar el blob,
-- y reextraer se decide comparando sha256, no fechas.
CREATE TABLE IF NOT EXISTS pva_file_text (
  file_id     INTEGER PRIMARY KEY REFERENCES pva_file(file_id) ON DELETE CASCADE,
  sha256      TEXT    NOT NULL,                -- del blob del que salió
  extractor   TEXT    NOT NULL,                -- pdf|docx|pptx|doc|html|ocr
  pages       INTEGER,
  content     TEXT    NOT NULL,
  extracted_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS pva_file_text_fts USING fts5(
  filename, content,
  content='pva_file_text', content_rowid='file_id',
  tokenize="unicode61 remove_diacritics 2"
);

-- contents[] con type='url' no es un archivo: no tiene filesize útil, ni
-- mimetype, ni filepath, ni sortorder. Vive aparte para que ninguna consulta de
-- bytes o de descarga lo toque por accidente.
CREATE TABLE IF NOT EXISTS pva_link (
  link_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  course_id    INTEGER NOT NULL,
  cmid         INTEGER NOT NULL,
  name         TEXT    NOT NULL,               -- contents[].filename
  url          TEXT    NOT NULL,               -- host externo
  host         TEXT    NOT NULL,
  timemodified INTEGER NOT NULL,
  seen_at      INTEGER NOT NULL,
  UNIQUE (cmid, url)
);

-- Resumen por módulo: sirve para decidir si vale la pena abrirlo.
CREATE TABLE IF NOT EXISTS pva_module_contents_info (
  cmid            INTEGER PRIMARY KEY REFERENCES pva_module(cmid) ON DELETE CASCADE,
  files_count     INTEGER NOT NULL DEFAULT 0,
  files_size      INTEGER NOT NULL DEFAULT 0,  -- 0 en page y url aunque haya archivo
  last_modified   INTEGER NOT NULL DEFAULT 0,  -- el mejor watermark por módulo
  mime_types_json TEXT    NOT NULL DEFAULT '[]',
  repository_type TEXT,                        -- '' local; CLAVE AUSENTE cuando files_count = 0
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

## Superficie de escritura

**Nada de esto se ejecutó en el recon.** Lo único confirmado es que las
funciones existen en el catálogo, más lo que `site_info` declara sobre la
capacidad de subir. Las formas de respuesta de las cuatro funciones de escritura
son supuesto.

Confirmado por `site_info`: `siteurl` con subruta, `uploadfiles = 1`,
`downloadfiles = 1`, `usercanmanageownfiles = true`, `usermaxuploadfilesize`
500 MB por archivo, `userquota` 100 MB en el área privada.

| Función | Estado | Qué hace |
|---|---|---|
| `core_files_get_unused_draft_itemid` | expuesta, no llamada | reserva el `itemid` de draft |
| `POST {SITEURL}/webservice/upload.php` | **no es una `wsfunction`**, no aparece en las 438, no probada | sube multipart con `token`, `filepath` e `itemid`; devuelve el descriptor del draft |
| `mod_assign_start_submission` | expuesta, no llamada | abre el intento cuando el `status` es `new` |
| `mod_assign_save_submission` | expuesta, no llamada | guarda el contenido: `itemid` del filemanager y/o `onlinetext` |
| `mod_assign_submit_for_grading` | expuesta, no llamada | envía para calificar; toma `acceptsubmissionstatement`. **Con `submissiondrafts = 0` en las 17 tareas vistas, probablemente no haga falta nunca acá** |
| `mod_assign_remove_submission` | expuesta, no llamada | elimina la entrega |
| `core_files_delete_draft_files` | expuesta, no llamada | limpia el draft area |
| `core_user_add_user_private_files` / `core_user_update_private_files` / `core_user_prepare_private_files_for_edition` | expuestas, no llamadas | archivos privados |
| `mod_assign_view_assign` / `mod_assign_view_submission_status` | expuestas, no llamadas | **escriben**: marcan visto y disparan eventos de log |

Secuencia estándar de Moodle, **a verificar contra 5.1**:

```text
core_files_get_unused_draft_itemid
  -> POST multipart a {SITEURL}/webservice/upload.php con ese itemid
  -> mod_assign_save_submission pasando el itemid en el plugin filemanager
  -> si submissiondrafts = 1, mod_assign_submit_for_grading
  -> refetch de mod_assign_get_submission_status
```

### Precauciones que el recon sí puede justificar

- **`cmid` no es parámetro de nada de esto.** `mod_assign_view_assign` recibe
  `assignid` (el mismo id de instancia de `get_submission_status`), y
  `upload.php` no acepta `cmid` ni contextid de módulo: sube al área draft del
  usuario con token, filepath e itemid. El `cmid` sirve para armar la URL web y
  para cruzar con `core_course_get_contents`.
- **Dos límites independientes.** `userquota` 100 MB (área privada, total)
  contra `maxsubmissionsizebytes` 500 MB (por archivo de entrega). La ruta de
  archivos privados topa mucho antes que la de entrega, y hay que chequear los
  dos.
- **`configs[].value` es siempre string**: `maxfilesubmissions`,
  `maxsubmissionsizebytes` y `filetypeslist` hay que castearlos antes de validar
  el archivo del usuario. `filetypeslist` vacío = cualquier extensión.
- **`requiresubmissionstatement = 0` y `submissiondrafts = 0` en las 17 tareas
  vistas**, pero es configuración por tarea. No mandar `acceptsubmissionstatement
  = 1` a ciegas ni asumir el paso de borrador. El texto de la declaración
  (`submissionstatement`) **no lo expone ninguna función volcada**: es un ajuste
  de sitio, y hoy no hay ninguna declaración activa que capturar.
- **`maxattempts = 1` y `attemptreopenmethod = 'untilpass'` en las 17**: no hay
  reintento que ofrecer en la UI salvo que el profesor reabra.
- **`mod_assign_view_assign` queda fuera del ciclo automático a propósito**,
  porque marcaría como vistas tareas que el estudiante no abrió.
- **Ninguna función del ciclo de lectura escribe.** Eso hay que mantenerlo
  explícito: la única mutación aceptable sin confirmación es ninguna.

### Lo que falta del lado feedback

El esquema de tareas guarda la nota, pero `feedback` trae dos cosas más que
ninguna tabla de este mapa cubriría si solo se guardara el número: los
`editorfields` del plugin `comments` (HTML del profesor) y los archivos de
`editpdf`. El primero va en `pva_submission_feedback.comment_html`; los segundos
van en `pva_file` con `component = 'assignfeedback_editpdf'` y `area =
'combined'`, **filtrando explícitamente `pages`, `readonlypages` y `stamps`**.

## Jerarquía recomendada de fuentes

| Información | Fuente preferida | Alternativa | Notas |
|---|---|---|---|
| identidad, `userid`, `siteurl` | `core_webservice_get_site_info` | ninguna | es la raíz, no hay sustituto |
| qué funciones se pueden llamar | `site_info.functions` | ninguna | por token, no por sitio |
| qué features están vivas | `site_info.advancedfeatures` + `tool_mobile_get_config` | ninguna | una función viva puede estar apagada por feature |
| lista de cursos | `core_enrol_get_users_courses` | ninguna | única fuente de `hidden`, `showgrades`, `format`, `lang`, ventana |
| árbol de un curso | `core_course_get_contents` | `core_courseformat_get_overview_information` (no llamada) | una llamada trae todo |
| finalización de actividades | `contents[].modules[].completiondata` | `core_completion_get_activities_completion_status` | la segunda es **redundante**, cero información nueva |
| fecha de entrega de una tarea | `mod_assign_get_assignments` | `modules[].dates[]` o `customdata` de `get_contents` | el plan B sale gratis si ya se bajó el curso |
| estado de una entrega | `mod_assign_get_submission_status` | ninguna | única fuente de `canedit` / `cansubmit` / `locked` |
| **lo que vence pronto** | `core_calendar_get_action_events_by_timesort` | `mod_assign_get_assignments` por curso | 1 llamada global contra N por curso, y el servidor ya calcula `overdue` |
| historial y lo ya entregado | `core_calendar_get_calendar_monthly_view` (no llamada) | `upcoming_view`, `get_calendar_events`, `day_view` | el feed de acciones **no** los trae |
| total de un curso | `gradereport_overview_get_course_grades` | ninguna | 1 llamada para todos los cursos |
| notas por item | `gradereport_user_get_grade_items` | `mod_assign_get_submission_status` por tarea | el fallback es **obligatorio** con `showgrades = false` |
| si el libro es accesible | `showgrades` + `gradereport_user_get_access_information` (no llamada) | try/catch sobre `nopermissiontoviewgrades` | |
| foro de anuncios | `mod_forum_get_forums_by_courses` (`type = 'news'`) | ninguna | `get_contents` no distingue foro de anuncios |
| contenido de un anuncio | `mod_forum_get_forum_discussions` (no sondeada) | ninguna | hueco central del dominio de avisos |
| tarea por vencer | `message_popup_get_popup_notifications` | calendario | |
| tarea nueva | **diff** de `mod_assign_get_assignments` | diff de `get_contents` | **no existe notificación de creación** |
| archivos de un curso | `core_course_get_contents[].contents[]` | `mod_*_get_*_by_courses` (no llamadas) | |
| cuerpo de una página | bajar el `index.html` por pluginfile | `mod_page_get_pages_by_courses` (no llamada) | `filesize` llega `0` y engaña |
| delta de un curso | `core_course_get_updates_since` con `since` real | hash local del árbol | probada en vivo, no en el volcado |
| descarga de archivo | `tokenpluginfile.php/{accesskey}/` | `pluginfile.php?...&token=` | la primera no deja el token en logs |
| **horario, matrícula, pénsum, deuda, índice, asistencia** | **MiCampus (PeopleSoft)** | ninguna | **la PVA no los tiene** |

## Estados que el cliente debe distinguir

Nunca convertir todos estos casos en `[]`.

| Estado | Señal |
|---|---|
| función ausente del catálogo | el nombre no está en `site_info.functions`. Es **capability ausente**, no error |
| función viva pero apagada por feature | está en `functions`, pero su `advancedfeature` vale `0` |
| función viva pero fuera del rol | responde `nopermission*` siempre, en todos los cursos |
| **sin permiso en ESE curso** | `errorcode: 'nopermissiontoviewgrades'` en un curso y `ok` en otro, con el mismo token y el mismo minuto |
| libro deshabilitado por el profesor | `showgrades: false`, ausente del overview, y excepción en `get_grade_items` |
| vacío real | HTTP 200 con `{...: [], warnings: []}` y el envoltorio esperado |
| vacío que parece error | `updates_since` con `instances: []` porque la ventana `since` es corta |
| curso sin contenido | secciones presentes con `modules: []` (plantilla creada, contenido no) |
| módulo inaccesible | aparece en `warnings[]` de `mod_assign_get_assignments`, con `itemid` = cmid que **no está** en el contenido visible |
| token muerto | `errorcode: 'invalidtoken'` o `accessexception` en la siguiente llamada. **No hay forma de preguntarlo antes** |
| política de sitio nueva | `errorcode: 'sitepolicynotagreed'` en **todas** las llamadas de golpe |
| upgrade del sitio | `site_info.version` cambió de sello |
| descarga fallida disfrazada de éxito | HTTP 200 con `Content-Type: application/json` y `errorcode`, o 303 hacia el login |
| ausencia ambigua en el calendario | evento que deja de venir: puede ser entrega hecha, borrado, o fuera de ventana. **Se marca, no se borra** |

## Estrategia de integración

### Orden de arranque en frío

```text
1. core_webservice_get_site_info        (userid, siteurl, catálogo, límites)
2. tool_mobile_get_config               (zona horaria, política, colores)
3. core_enrol_get_users_courses         (hidden, showgrades, format, lang, ventana)
4. core_calendar_get_action_events_by_timesort   (agenda usable en 1 llamada)
5. gradereport_overview_get_course_grades        (totales en 1 llamada)
6. core_course_get_contents              solo para los cursos con hidden = false
7. mod_assign_get_assignments            en lote, con courseids[] de esos cursos
8. mod_assign_get_submission_status      solo de las tareas cuyo TTL venció
```

Los pasos 4 y 5 dan una pantalla útil con **dos peticiones**. Los pasos 6 a 8 son
los caros y se pueden diferir. El fan-out se agrupa con
`tool_mobile_call_external_functions`, que empaqueta N llamadas en un POST, y eso
importa más de lo normal por `limitconcurrentlogins = 1`.

### TTL por recurso

| Recurso | TTL primer plano | TTL fondo | Justificación |
|---|---|---|---|
| `pva:site_info` | 6 h | 6 h | es además el health check del token |
| `pva:config` | 24 h | 24 h | es del sitio, no de la persona: una fila compartida |
| `pva:functions` | sin TTL | | se reescribe solo si cambia el hash del catálogo |
| `pva:courses` | 12 h | 12 h | una materia nueva no aparece a media semana |
| `calendar.action_timesort` | 15 min, o 5 min si el evento más próximo está a menos de 24 h | 6 h | 6 de 7 eventos son de un alta masiva, pero 1 fue tocado en las últimas 24 h: los profesores mueven fechas cerca del vencimiento |
| `grades.overview` | 30 min (piso de 2 min en pull-to-refresh) | 30 min | **el disparador barato**: 1 llamada, marca cursos sucios |
| `grades.items:<course>` | invalidado por el disparador, o 30 s al abrir el curso | 6 h con actividad reciente, 24 h el resto | a ciegas serían tantas peticiones como cursos elegibles |
| `assignments:<course>` | forzado al abrir el curso | 6 h | cambia poco |
| `submission:<assign>` | 5 min en pantalla, 30 min si vence en menos de 48 h | 6 h entregada sin calificar, 24 h ya calificada, nunca si vencida + cerrada + calificada | es la cara del dominio |
| `contents:<course>` | solo si `updates_since` da señal | piso de 24 h | 182 KB la respuesta más pesada |
| `forums` | 24 h | 24 h | un lote con `courseids[]` de todos los cursos activos |
| `discussions:<forum>` | 60 min, **solo** foros `type = 'news'` con `numdiscussions` mayor al guardado | | |
| `notifications` | 5 min, más pull forzado cuando sube el conteo | 30 min | |
| `notifications.count` | 120 s | 15 min | solo un entero |
| blob en disco | **nunca por TTL** | | solo revalidación condicional con `If-None-Match`. El servidor dice `max-age=21600` |

Render **stale-while-revalidate** en todas: la pantalla se pinta desde SQLite sin
esperar la red. Nunca hay pantalla vacía mientras se sincroniza.

### Delta, capa por capa

1. **Hash del catálogo de funciones.** `functions_hash = sha256` de
   `name:version` ordenado y concatenado. Si coincide, no se tocan las 438 filas.
2. **Disparador barato de notas.** `gradereport_overview_get_course_grades`, 1
   llamada; se compara **`rawgrade` en texto**, nunca `grade`; los cursos que
   cambian se marcan sucios y solo esos gastan una llamada de detalle.
3. **Delta de servidor por curso.** `core_course_get_updates_since(courseid,
   since)` con un `since` **real** (el guardado, no una ventana corta). Se
   descarta `configuration` como señal pero se conserva su `timeupdated` como
   fuente de fecha. La señal útil de archivos es `contentfiles`, `introfiles`,
   `introattachmentfiles`, que además traen `itemids`.
4. **Delta local por hash.** Si hay señal, un solo `get_contents` del curso; se
   normaliza y se hashea. Si el hash coincide con el guardado, no hay diff. Si
   no, se comparan hashes por módulo y solo se escriben las filas que cambiaron.
5. **Delta de blob.** GET condicional con `If-None-Match` del ETag guardado. 304
   toca solo `verified_at`; 200 reescribe el blob, recalcula el sha256 y, si el
   sha cambió, invalida `pva_file_text`.
6. **Cursor.** Avanzar `server_since` con el reloj de la petición menos 60 s. **No
   se puede derivar del payload** de los updates de archivo, porque no traen
   `timeupdated`.

Lo que **no** sirve como disparador de delta, comprobado:
`core_enrol_get_users_courses[].timemodified` (el contenido es más nuevo que
ese campo), `forum.timemodified` (es la configuración), `numdiscussions` para
detectar ediciones, `read` de la campanita (lo mueve el portal web), y
`timemodified` de los ficheros (es la fecha de la restauración del curso).

### Borrado

Nunca en duro, en ningún dominio: módulo, archivo, evento, item del libro o
tarea que deja de aparecer se marca (`seen_at`, `deleted_at`, `missing_since`,
`gone_at`) y se filtra. Un cmid puede volver, un profesor puede ocultar y
reponer un item, y un evento desaparece por tres razones distintas. Borrar en
duro convierte cualquiera de esas en "nota nueva" o en pérdida de historial.

### Manejo de fallos

| `errorcode` | Qué significa | Qué hacer |
|---|---|---|
| `invalidtoken`, `accessexception` | el token fue revocado o cambió la contraseña | borrarlo del credentialStore y volver a `login/token.php` |
| `sitepolicynotagreed` | apareció una política de sitio | `core_user_agree_site_policy` o `tool_policy_set_acceptances_status`, ambas expuestas |
| `nopermissiontoviewgrades` y demás `nopermission*` | es **por curso o por rol**, no por token | marcar ese curso como sin ese dato, registrar el `errorcode`, no reintentar antes de 24 h, y **seguir con el resto**. Nunca abortar el ciclo |
| cualquier otro | HTTP 200 con `errorcode` | registrar y tratar como fallo de esa rama, no como dato vacío |

`site_info.version` es el disparador de invalidación global: si el sello cambia,
hubo upgrade y hay que (1) rehacer el diff del catálogo marcando `gone_at`,
(2) invalidar todos los caches por curso porque pudieron aparecer o irse campos,
y (3) volver a correr el recon completo antes de confiar en cualquier parser.

## Lo que la PVA no reemplaza

Esta instancia expone 438 funciones y **ninguna es de PUCMM salvo una de
competencias**. No hay ninguna función institucional para horario, matrícula,
pénsum, deuda ni índice académico, y no hay ningún plugin de asistencia
(`mod_attendance_*` no existe en el catálogo).

| Dato | Dónde vive |
|---|---|
| horario, aula, profesor de la sección | MiCampus |
| matrícula, carrito, formalización | MiCampus |
| pénsum, requisitos, advisement report | MiCampus |
| balance, cargos, pagos | MiCampus |
| índice académico y su estimación | MiCampus |
| asistencia a clase | MiCampus |
| historial de notas oficiales | MiCampus |
| tareas, entregas, materiales, foros, notas del aula | **PVA** |

Las dos fuentes no se solapan en casi nada, y donde parecen solaparse (notas) no
significan lo mismo: la nota del libro de la PVA es la del aula, no la oficial
del expediente.

## Cobertura del recon y huecos conocidos

| Estado | Qué |
|---|---|
| volcado y verificado | `core_webservice_get_site_info`, `tool_mobile_get_config`, `core_enrol_get_users_courses`, `core_course_get_contents` (3 cursos), `core_completion_get_activities_completion_status` (3), `mod_assign_get_assignments` (3), `mod_assign_get_submission_status` (3 tareas), `gradereport_user_get_grade_items` (2 ok, 1 error), `gradereport_overview_get_course_grades`, `core_calendar_get_action_events_by_timesort`, `mod_forum_get_forums_by_courses` (3), `mod_quiz_get_quizzes_by_courses` (3, vacías), `core_message_get_conversations`, `message_popup_get_popup_notifications`, `core_user_get_private_files_info`, `core_course_get_updates_since` (3, vacías) |
| probado en vivo, fuera del volcado | descarga por `pluginfile.php` y `tokenpluginfile.php` (200, ETag, 304, 206, chunked), errores 200-con-JSON y 303, `core_course_get_updates_since` con `since = 0` |
| envoltorio confirmado, elemento nunca visto | `core_course_get_updates_since.instances[]` (en el volcado), `mod_quiz_get_quizzes_by_courses.quizzes[]`, `warnings[]` de `tool_mobile_get_config` |
| **hueco central** | `mod_forum_get_forum_discussions`: sin ella no hay contenido de anuncio, solo el contador |
| **hueco de notas** | un volcado con al menos un item **calificado**: hoy `graderaw` y `gradedategraded` son `null` en el 100% de los items observados |
| **hueco de calendario** | cualquier función que traiga eventos sin acción pendiente |
| **hueco de escritura** | las 4 funciones del ciclo de entrega y `upload.php`: existencia confirmada, forma de respuesta desconocida |
| estados nunca observados | `submission.status` en `new`/`draft`/`reopened`; `gradingstatus` de marking workflow; `completiondata.state` en `2`/`3`; `itemtype` en `category`/`manual`/`outcome`; `scaleid` no nulo; `overdue: true`; una entrega tardía; una prórroga real; una entrega grupal; `isexternalfile: true`; `filepath` con subcarpetas; `contents[].type = 'content'` |
| modname nunca vistos | 13 con lector expuesto (`quiz`, `choice`, `lesson`, `feedback`, `workshop`, `data`, `wiki`, `scorm`, `h5pactivity`, `bigbluebuttonbn`, `lti`, `book`, `imscp`) y **`customcert`, que está instalado y no tiene lector** |

Una muestra de 3 cursos de una sola cuenta no es el sitio. Cada vez que este
mapa dice "en el volcado", lo que sigue es una observación de esa muestra; cada
vez que dice "según protocolo" o "supuesto", es memoria de Moodle que hay que
verificar contra 5.1 antes de escribir el parser encima.
