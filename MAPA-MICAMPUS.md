# Mapa técnico completo de MiCampus PUCMM

> Reconstruido mediante una sesión autenticada de navegador contra `micampus.pucmm.edu.do`
> el 2026-07-18. El propósito de este documento es describir la arquitectura, las
> rutas, los formularios y los selectores necesarios para construir scrapers. No
> contiene datos del estudiante observado.

## Alcance y reglas de privacidad

Este mapa guarda estructura del portal, no contenido personal. Nunca deben entrar al
repositorio nombres, matrícula/`EMPLID`, teléfonos, correos, direcciones, profesores
asociados al horario de una persona, cursos inscritos, calificaciones, montos, mensajes,
respuestas de evaluación ni tokens de sesión. En fixtures, reemplazar esos valores por
datos sintéticos conservando el HTML y los IDs de campos.

Valores que siempre se deben limpiar:

| Valor | Sustitución recomendada |
|---|---|
| `EMPLID` | `{EMPLID}` |
| `CLASS_NBR` observado | `{CLASS_NBR}` |
| `STRM` observado | `{STRM}` |
| `PUC_ID_EVAL` | `{PUC_ID_EVAL}` |
| nombre, email, teléfono, dirección | valores sintéticos |
| `ICSID`, cookies, cabeceras de autenticación | eliminar por completo |
| sufijo de instancia `cs92pro_N` | normalizar a `cs92pro` |

## Modelo de navegación de PeopleSoft

La aplicación combina tres superficies:

1. **Fluid**: homepage de tiles y módulos con navegación lateral. Usa principalmente
   `/psc/cs92pro/EMPLOYEE/SA/c/...`.
2. **Classic**: componentes antiguos, tablas HTML y formularios PeopleSoft. Se abren
   directamente o dentro del iframe `TargetContent` del Centro del Alumnado.
3. **Portal shell**: menú de carpetas, breadcrumbs e iframes. Usa rutas `/psp/...` e
   IScripts para poblar el árbol.

Convenciones:

```text
ORIGEN = https://micampus.pucmm.edu.do
PSC    = /psc/cs92pro/EMPLOYEE/SA/c
PSP    = /psp/cs92pro/EMPLOYEE/SA/c
```

`/psc/` entrega el contenido del componente; `/psp/` añade el shell del portal. Para
scraping suele convenir `/psc/`. El sufijo dinámico `cs92pro_N` identifica una instancia
de navegación de la sesión y no es una ruta canónica.

### Estado de formularios

PeopleSoft no funciona como una colección de GET independientes. Cada componente tiene
un formulario cuyo `action` apunta al mismo componente e incluye campos ocultos como
`ICStateNum`, `ICAction`, `ICElementNum`, `ICFocus`, `ICChanged` e `ICSID`. Las acciones
de filas, filtros, paginación y botones son POST de ese formulario. Para reproducir una
acción de lectura:

1. abrir el componente dentro de la misma sesión autenticada;
2. conservar todos los campos ocultos recibidos en esa respuesta;
3. poner el ID del control en `ICAction` o ejecutar la acción equivalente;
4. enviar el formulario al `action` actual;
5. reemplazar el estado oculto con el de la nueva respuesta.

No persistir `ICSID`. Tampoco construir peticiones con un `ICStateNum` viejo: PeopleSoft
puede responder con una pantalla incorrecta, un error de estado o un redirect.

### Contexto Fluid y selectores estables

Las páginas `*_START_*` establecen el navigation collection. Abrir directamente una hoja
Fluid en una sesión nueva puede producir `bIsCalledOutsideNavigationCollection`. La ruta
robusta es tile/START → master-detail (`*_MD_*`) → hoja.

Los prefijos de wrapper `win0div`, `win1div` y los números `winN` son transitorios. Usar
el ID semántico del control (`CRSE_TERM3`, `EMAIL_ADDR$N`, etc.). Las filas suelen tener
el patrón `tr<SCROLL>$0_rowN` o `<SCROLL>$0_row_N`; `$N` es índice global de scroll, no
siempre índice visual. Agrupar cada registro por su `<tr>` o contenedor padre.

Las tablas pueden mostrar solo 15 filas. Antes de extraer, buscar `$hviewall$0` o recorrer
`$hdown$0`/`$hup$0`. Algunos componentes ofrecen `$hexcel$0`; es útil si la respuesta es
un archivo de solo lectura, pero el HTML sigue siendo la fuente más uniforme.

## Homepage Fluid

Landing canónico:

```text
/psc/cs92pro/EMPLOYEE/SA/c/NUI_FRAMEWORK.PT_LANDINGPAGE.GBL
```

La homepage observada contiene nueve tiles. La ruta “START” es la que se debe lanzar en
una sesión fresca; “MD” es la URL que queda después de crear el contexto.

Las rutas START de la tabla se anexan a
`/psc/cs92pro_newwin/EMPLOYEE/SA/c/`; las MD/hojas se pueden normalizar luego al prefijo
`/psc/cs92pro/EMPLOYEE/SA/c/`. `newwin` es una instrucción del portal, no otro servidor.

| Tile | Ruta START / launch | Componente MD resultante |
|---|---|---|
| Academic Progress | `SAA_STUDENT_FL.SAA_START_PAGE_FL.GBL?GMenu=SAA_STUDENT_FL&GComp=SAA_START_PG_SP_FL&GPage=SAA_START_PAGE_FL&scname=CS_SAA_ACADEMIC_PROGRESS_FL` | `SAA_STUDENT_FL.SAA_MD_ACADPROG_FL.GBL` |
| Academic Records | `SSR_STUDENT_ACAD_REC_FL.SSR_SP_ACAD_REC_FL.GBL?GMenu=SSR_STUDENT_ACAD_REC_FL&GComp=SSR_ACADREC_NAV_FL&GPage=SCC_START_PAGE_FL&scname=CS_SSR_ACADEMIC_RECORDS_FL` | `SSR_STUDENT_ACAD_REC_FL.SSR_MD_ACAD_REC_FL.GBL` |
| Financial Account | `SSF_STUDENT_FL.SSF_FIN_ACCT_ML_FL.GBL?GMenu=SSF_STUDENT_FL&GComp=SSF_FIN_ACCT_SP_FL&GPage=SCC_START_PAGE_FL&scname=CS_FINANCIAL_ACCOUNT` | `SSF_STUDENT_FL.SSF_FIN_ACCT_MD_FL.GBL` |
| Financial Aid | `SFA_STUDENT_FL.SFA_SS_START_PG_FL.GBL?GMenu=SFA_STUDENT_FL&GComp=SFA_SS_START_PG_FL&GPage=SFA_SS_START_PG_FL&scname=CS_FINANCIAL_AID_SS_LFF_MENU&scnamesff=CS_FINANCIAL_AID_SS_SFF_MENU` | mismo componente START |
| Manage Classes | `SSR_STUDENT_FL.SSR_START_PAGE_FL.GBL?GMenu=SSR_STUDENT_FL&GComp=SSR_START_PAGE_FL&GPage=SSR_START_PAGE_FL&scname=CS_SSR_MANAGE_CLASSES_NAV` | `SSR_STUDENT_FL.SSR_MD_SP_FL.GBL` |
| Profile | `SCC_PROFILE_FL.SCC_PROFILE_FL.GBL?GMenu=SCC_PROFILE_FL&GComp=SCC_PROFILE_SP_FL&GPage=SCC_START_PAGE_FL&scname=CS_PERSON_PROFILE&scnamem=CS_PERSON_PROFILEMF` | `SCC_PROFILE_FL.SCC_PROFILE_MD_FL.GBL` |
| Tasks | `SCC_TASKS_FL.SCC_TASKS_START_FL.GBL?GMenu=SCC_TASKS_FL&GComp=SCC_TASKS_SP_FL&GPage=SCC_START_PAGE_FL&scname=CS_TASKS` | `SCC_TASKS_FL.SCC_TASK_MD_TGT_FL.GBL` |
| Centro del Alumnado | `NUI_FRAMEWORK.PT_AGSTARTPAGE_NUI.GBL?CONTEXTIDPARAMS=TEMPLATE_ID%3aPTPPNAVCOL&scname=ADMN_CENTRO_DEL_ALUMNADO&PTPPB_GROUPLET_ID=CENTROALUMNADO&CRefName=ADMN_NAVCOLL_1` | nav collection con iframe |
| Evaluación Profesoral | `/psp/cs92pro_newwin/EMPLOYEE/SA/c/PUC_CUSTOM_CS.PUC_EVAL_DOC_ALU.GBL?1` | componente Classic custom |

En la homepage, los tiles usan `LaunchURL(...)`; no depender del orden visual ni del
texto del badge, porque ambos varían por usuario y estado.

## Academic Progress

Base MD: `SAA_STUDENT_FL.SAA_MD_ACADPROG_FL.GBL`.

| Sección | Hoja Fluid |
|---|---|
| Summary | `SAA_STUDENT_FL.SAA_ACD_PRG_SM_FL.GBL?Page=SAA_ACD_PRG_SM_FL&pslnkid=CS_S201603172340124146686193` |
| Academic Progress | `SAA_STUDENT_FL.SAA_ACAD_PROG_FL.GBL?Page=SAA_ACAD_PROG_FL&pslnkid=CS_S201603172342118128112493` |
| Course Requirement Alerts | `SAA_STUDENT_FL.SAA_CRS_REQ_ALT_FL.GBL?Page=SAA_CRS_REQ_ALT_FL&pslnkid=CS_S201603172343013705835185` |
| Expected Graduation Term | `SAA_STUDENT_FL.SAA_EXP_GRD_TRM_FL.GBL?Page=SAA_EXP_GRD_TRM_FL&pslnkid=CS_S201603172343528861244199` |
| Advisors | `SAA_STUDENT_FL.SAA_ADVISORS_FL.GBL?Page=SAA_ADVISORS_FL&pslnkid=CS_S201603162344321670950325` |

En Academic Progress, cada requirement group usa `SAA_ARSLT_RGVW$0_row_N`. Campos:

| Dato | ID |
|---|---|
| título/acción del grupo | `DERIVED_SAA_FL_SAA_DESCR80$N` |
| estado | `DERIVED_SAA_FL_DESCR$N` |
| unidades | `DERIVED_SAA_FL_SAA_DESCR1$N` |
| cursos | `DERIVED_SAA_FL_SAA_DESCR2$N` |
| GPA | `DERIVED_SAA_FL_SAA_DESCR3$N` |
| refrescar informe | `DERIVED_SAA_FL_SAA_REFRESH_PB` |

El advisement report clásico sigue siendo mejor para requisitos detallados. El resumen
Fluid es útil para estados y métricas, pero no demuestra prerrequisitos de una materia.
Su componente Classic directo es `SA_LEARNER_SERVICES.SSS_MY_ACAD.GBL?Page=SSS_MY_ACAD&Action=U`.

## Academic Records

Base MD: `SSR_STUDENT_ACAD_REC_FL.SSR_MD_ACAD_REC_FL.GBL`.

| Sección | Hoja Fluid |
|---|---|
| Course History | `SSR_STUDENT_ACAD_REC_FL.SSR_CRSE_HIST_FL.GBL?Page=SSR_CRSE_HIST_FL&pslnkid=CS_S201605051911149930439391` |
| View Grades | `SSR_STUDENT_ACAD_REC_FL.SSR_ACAD_REC_FL.GBL?Page=SSR_VWGD_GRADE_FL&pslnkid=CS_S201605051912296299625833` |
| View Unofficial Transcript | `SSR_STUDENT_ACAD_REC_FL.SSR_VW_UNOFF_TS_FL.GBL?Page=SSR_VW_UNOFF_TS_FL&pslnkid=CS_SSR_VW_UNOFF_TS_FL_LNK` |
| Request Official Transcript | `SSR_STUDENT_ACAD_REC_FL.SSR_RQST_OFF_TS_FL.GBL?Page=SSR_RQST_OFF_TS_FL&pslnkid=CS_SSR_RQST_OFF_TS_FL_LNK` |

Course History expone una fila por curso. Campos:

| Dato | ID base |
|---|---|
| subject + catálogo | `DERIVED_SSS_HST_SSS_SUBJ_CATLG$80$N` |
| nombre largo | `DERIVED_SSS_HST_SSR_CLASSNAME_LONG$83$N` |
| término | `CRSE_TERM3$N` |
| nota | `DERIVED_SSS_HST_CRSE_GRADE_OFF$N` |
| unidades | `DERIVED_SSS_HST_UNT_TAKEN$N` |
| estado | `DERIVED_SSS_HST_SSR_STATUS_LONG$N` |

Los estados incluyen Planned, In Progress, Taken y Transferred; no asumir que una fila
tiene nota. La ruta clásica del historial es `SA_LEARNER_SERVICES_2.SSS_MY_CRSEHIST.GBL`.

Transcript no oficial usa los radios `DERIVED_SSR_FL_SSR_VW_UNOFF_TS_FL` y
`DERIVED_SSR_FL_SSR_VW_UNOFF_TS_FL$22$`, el tipo de reporte
`DERIVED_SSTSRPT_TSCRPT_TYPE3` y `DERIVED_SSTSRPT_REPORT_REQUEST_PB`. Depende de tipos
habilitados y genera un reporte/pop-up; no es la mejor fuente primaria. La solicitud de
transcript oficial puede estar visible pero no autorizada para el usuario.

## Financial Account

Base MD: `SSF_STUDENT_FL.SSF_FIN_ACCT_MD_FL.GBL`.

| Sección | Ruta |
|---|---|
| Account Balance | `SSF_STUDENT_FL.SSF_FIN_ACCT_FL.GBL?Page=SSF_ACCT_BAL_FL&pslnkid=CS_S201603291709592420117801` |
| Make a Payment | `SSF_MAP_FL.SSF_SS_PMT_FL.GBL?pslnkid=CS_S201605082300228490016054` |
| Charges Due | `SSF_STUDENT_FL.SSF_CHRGS_DUE_FL.GBL?Page=SSF_CHRGS_DUE_FL&pslnkid=CS_S201606061419184192632831` |
| Direct Deposit | `SSF_STUDENT_FL.SSF_DIR_DEP_FL.GBL?Page=SSF_DIR_DEP_FL&pslnkid=CS_S201701250105205437486891` |
| Payment History | `SSF_STUDENT_FL.SSF_PMT_HIST_FL.GBL?Page=SSF_PMT_HIST_FL&pslnkid=CS_S201610262128097356486709` |

Account Services enlaza componentes Classic:

| Servicio | Ruta |
|---|---|
| View 1098-T | `SA_LEARNER_SERVICES.SSF_SS_1098.GBL` |
| Enroll in Payment Plan | `SA_LEARNER_SERVICES.SSF_SS_PPL_ENRL.GBL` |
| Purchase Miscellaneous Items | `SA_LEARNER_SERVICES.SSF_SS_MISC_PUR.GBL` |
| View Student Permissions | `SA_LEARNER_SERVICES.SSF_SS_PERM_VIEW.GBL` |
| Charges Due Classic | `SA_LEARNER_SERVICES.SSF_SS_CHRGS_DUE.GBL` |

Charges Due selecciona summary con `SSF_DER_CHDU_FL_SSF_CHRGDUE_OPT_FL` y detail con
`SSF_DER_CHDU_FL_SSF_CHRGDUE_OPT_FL$10$`. Los mensajes vacíos están en
`DERIVED_SSF_MSG_SSF_MSG_LONG` y la ayuda pendiente en `DERIVED_SSF_MSG_SSF_MSG_LONG2`.

Payment History usa filas `SSF_SS_POST_PAY$0_row_N`:

| Dato | ID |
|---|---|
| fecha | `SSF_POSTED_DATE$N` |
| detalle/acción | `TAPROW$N` |
| business unit | `DESCR$N` |
| monto | `PMT_AMT$N` |
| moneda | `SSF_SS_POST_PAY_CURRENCY_CD$N` |

`TAPROW$N` es una acción POST. Payment, Direct Deposit y Payment Plan son flujos que
pueden modificar estado o mover dinero; el scraper debe limitarse a sus páginas de
resumen salvo autorización explícita.

## Financial Aid

Ruta: `SFA_STUDENT_FL.SFA_SS_START_PG_FL.GBL` con los parámetros START de la tabla de
tiles. Cuando no existe información, la pantalla solo expone
`SFA_FL_MISC_WRK_SFA_USER_MESSAGE`. No se verificó un award grid porque la cuenta usada
para el recon no tenía datos disponibles; no inventar un esquema a partir de ese estado.

## Manage Classes

Base MD: `SSR_STUDENT_FL.SSR_MD_SP_FL.GBL`.

| Sección | Hoja Fluid |
|---|---|
| View My Classes | `SSR_STUDENT_FL.SSR_COMPONENT_FL.GBL?Page=SSR_VW_CLASS_FL&pslnkid=CS_S201605040129258749603935` |
| Shopping Cart | `SSR_STUDENT_FL.SSR_SHOP_CART_FL.GBL?Page=SSR_TERM_STA3_FL&pslnkid=CS_S201608070058152725454770` |
| Class Search and Enroll | `SSR_STUDENT_FL.SSR_CLSRCH_MAIN_FL.GBL?Page=SSR_CLSRCH_MAIN_FL&pslnkid=CS_S201605302223124733554248` |
| Drop Classes | `SSR_STUDENT_FL.SSR_DROP_CLASS_FL.GBL?Page=SSR_DROP_TERM_FL&pslnkid=CS_S201607141805059946044413` |
| Update Classes | `SSR_STUDENT_FL.SSR_EDIT_CLASS_FL.GBL?Page=SSR_EDIT_TERM_FL&pslnkid=CS_S201702062326499505976484` |
| Swap Classes | `SSR_STUDENT_FL.SSR_SWAP_CLASS_FL.GBL?Page=SSR_SWAP_TERM_FL&pslnkid=CS_S201702070207461556537361` |
| Browse Course Catalog | `SSR_STUDENT_FL.SSR_BROWSE_CTLG_FL.GBL?Page=SSR_BROWSE_CTLG_FL&pslnkid=CS_SSR_BROWSE_CTLG_FL_LINK` |
| Planner | `SSR_STUDENT_FL.SSR_PLANNER_FL.GBL?Page=SSR_PLNR_TERM_FL&pslnkid=CS_SSR_PLANNER_FL_LINK` |
| Enroll by My Requirements | `SSR_STUDENT_FL.SSR_REQ_ENRL_FL.GBL?Page=SSR_REQ_ENRL_FL&pslnkid=CS_SSR_REQ_ENRL_FL_LINK` |

Los términos de entrada se enlazan con `SSR_ENTRMCUR_VW_TERM_DESCR30$N`. Que una opción
aparezca en el menú no garantiza acceso: en el recon, Update, Swap, Planner y Enroll by
Requirements devolvieron “not authorized”. El scraper debe registrar esa condición, no
tratarla como ausencia de datos.

### Horario Classic

Vista semanal/lista:

```text
SA_LEARNER_SERVICES.SSR_SSENRL_SCHD_W.GBL
```

Si hay varios términos, seleccionar `SSR_DUMMY_RECV1$sels$N` y continuar. Cambiar a
lista con `DERIVED_REGFRM1_SSR_SCHED_FORMAT$258$`. Cada clase vive en
`ACE_STDNT_ENRL_SSV2$N`; sus reuniones contienen:

| Dato | ID |
|---|---|
| class number | `DERIVED_CLS_DTL_CLASS_NBR$N` |
| sección | `MTG_SECTION$N` |
| componente | `MTG_COMP$N` |
| día/hora | `MTG_SCHED$N` |
| aula | `MTG_LOC$N` |
| instructor | `DERIVED_CLS_DTL_SSR_INSTR_LONG$N` |
| fechas | `MTG_DATES$N` |

El `STRM` puede obtenerse del objeto JavaScript `PIA_KEYSTRUCT`. Para términos pasados,
`SA_LEARNER_SERVICES.SS_LAM_STD_GR_LST.GBL` suele ser más útil. Otras rutas Classic
directas verificadas: `SA_LEARNER_SERVICES.CLASS_SEARCH.GBL`,
`SA_LEARNER_SERVICES.SSS_BROWSE_CATLG.GBL`,
`SA_LEARNER_SERVICES.SSR_SSENRL_CART.GBL`,
`SA_LEARNER_SERVICES.SSR_SSENRL_DROP.GBL` y
`SA_LEARNER_SERVICES.SSR_SSENRL_GRADE.GBL`. Edit y Swap aparecen también registrados
en el árbol; comprobar autorización antes de iniciar cualquiera de esos flujos.

## Profile

Base MD: `SCC_PROFILE_FL.SCC_PROFILE_MD_FL.GBL`.

| Sección | Hoja Fluid |
|---|---|
| Personal Details | `SCC_PROFILE_FL.SCC_PERSON_DTLS_FL.GBL?Page=SCC_PERS_DTLS_FL&pslnkid=CS_S201605040340262226016168` |
| Contact Details | `SCC_PROFILE_FL.SCC_CONTCT_DTLS_FL.GBL?Page=SCC_CONTACT_DTL_FL&pslnkid=CS_S201605040344225739080452` |
| Addresses | `SCC_PROFILE_FL.SCC_ADDR_DTLS_FL.GBL?Page=SCC_ADDRESS_DTL_FL&pslnkid=CS_S201605040346234150768576` |
| Emergency Contacts | `SCC_PROFILE_FL.SCC_EMERG_CNTCT_FL.GBL?Page=SCC_EMERG_CNTCT_FL&pslnkid=CS_S201605040347096193270257` |
| Ethnicity | `SCC_PROFILE_FL.SCC_ETHNIC_US_FL.GBL?Page=SCC_ETHNIC_US_FL&pslnkid=CS_S201612160234019303465750` |
| Privacy Restrictions | `SCC_PROFILE_FL.SCC_FERPA_RES_FL.GBL?Page=SCC_FERPA_RES_FL&pslnkid=CS_S201701150603356866518360` |

Contact Details usa `EMAIL_ADDR$N`, `PHONE$N`, `SCC_PROF_FL_DRV_SCC_ADD_EMAIL` y
`SCC_PROF_FL_DRV_SCC_ADD_PHONE`. Todo el módulo es PII y varias acciones editan datos;
solo leer con fixtures completamente sintéticos.

## Tasks

Base MD: `SCC_TASKS_FL.SCC_TASK_MD_TGT_FL.GBL`.

| Sección | Hoja Fluid |
|---|---|
| To Do List | `SCC_TASKS_FL.SCC_TASKS_TODOS_FL.GBL?Page=SCC_TODO_LIST_FL&pslnkid=CS_S201605171610028145391404` |
| Holds | `SCC_TASKS_FL.SCC_TASK_HOLDS_FL.GBL?Page=SCC_HOLDS_LIST_FL&pslnkid=CS_S201605171612327382077862` |
| Completed Agreements | `SCC_TASKS_FL.SCC_TM_VW_AGREE_FL.GBL?Page=SCC_TM_VW_AGREE_FL&pslnkid=CS_S201706300246286516146835` |

To Do List usa `SCC_DRV_TASK_FL1$0_row_N`, acción
`SCC_DRV_TASK_FL_SCC_TODO_SEL_PB$N`, vencimiento `DUEDT1$N` y estado
`SCC_DRV_TASK_FL_XLATLONGNAME$129$$N`. Holds usa `SCC_HOLD_VW_FL1$0_row_N` y
`HOLD1$N`.

La vista Fluid puede renderizar un enlace vacío “Select Hold” mientras Student Center
Classic dice “No Holds”. Tratar un enlace sin nombre/departamento como placeholder y
confirmar en ambas fuentes. Completed Agreements puede aparecer en nav y responder
“not authorized”.

## Centro del Alumnado y shell Classic

El tile abre:

```text
/psc/cs92pro/EMPLOYEE/SA/c/NUI_FRAMEWORK.PT_AGSTARTPAGE_NUI.GBL?CONTEXTIDPARAMS=TEMPLATE_ID%3aPTPPNAVCOL&scname=ADMN_CENTRO_DEL_ALUMNADO&PTPPB_GROUPLET_ID=CENTROALUMNADO&CRefName=ADMN_NAVCOLL_1
```

El contenido real está en `iframe#ptifrmtgtframe`, `name="TargetContent"`, cuyo `src`
apunta a:

```text
/psc/cs92pro/EMPLOYEE/SA/c/SA_LEARNER_SERVICES.SSS_STUDENT_CENTER.GBL
```

También existen `RelatedContent` y `SRelatedContent`; no confundirlos con el contenido
principal. El formulario central es `SSS_STUDENT_CENTER`.

Las carpetas se cargan por IScript:

```text
/psp/cs92pro/EMPLOYEE/SA/s/WEBLIB_PTPP_SC.HOMEPAGE.FieldFormula.IScript_AppHP?pt_fname={FOLDER}&FolderPath={PATH}&IsFolder=true
```

En la raíz del shell también aparecen Student Center, Notifications Center, Reporting
Tools, PeopleTools, PUCMM Customización y My Preferences. Reporting Tools y PeopleTools
son utilidades del sistema, no fuentes académicas del estudiante. El shell expone además
enlaces externos a Biblioteca, PVA/Moodle, Publicaciones y recuperación de contraseña;
al salir de `micampus.pucmm.edu.do` terminan los componentes PeopleSoft cubiertos aquí.

### Acciones rápidas de Student Center

El selector Academics es `DERIVED_SSS_SCL_SSS_MORE_ACADEMICS` y su GO
`DERIVED_SSS_SCL_SSS_GO_1`:

| Valor | Acción |
|---:|---|
| 4010 | Academic Planner |
| 3010 | Academic Requirements |
| 3040 | Advising Notes |
| 2015 | Apply for Graduation |
| 1025 | Assignments |
| 1002 | Class Schedule |
| 2050 | Course History |
| 2010 | Enrollment Verification |
| 1005 | Add |
| 1008 | Drop |
| 1010 | Edit |
| 1015 | Swap |
| 1030 | Grades |
| 2025 | Transfer Credit Report |
| 9999 | other academic... |

Finances usa `DERIVED_SSS_SCL_SSS_MORE_FINANCES` + `DERIVED_SSS_SCL_SSS_GO_2`:
1000 Account Activity, 1010 Charges Due, 1020 Payments, 1030 Pending Aid y 9999 other.

Profile usa `DERIVED_SSS_SCL_SSS_MORE_PROFILE` + `DERIVED_SSS_SCL_SSS_GO_3`:
1010 Addresses, 1020 Email, 1090 Extracurricular, 1030 Honors, 1035 Internet, 1040
Languages, 1045 Licenses, 1050 Memberships, 1060 Phones, 1075 Publications, 1085 Work
Experience y 9999 other.

Enlaces adicionales: `DERIVED_SSS_SCL_SS_WEEKLY_SCHEDULE`,
`DERIVED_SSS_SCL_SSS_ENRL_CART$276$`, `DERIVED_SSS_SCR_SSS_LINK_ANCHOR1` a `4`,
`DERIVED_SSS_SCL_SS_VW_ACCT_LINK`, `DERIVED_SSS_SCL_SS_ACCT_PRFL_LINK`,
`DERIVED_SSS_SCL_SS_VW_AIDAWD_LINK`, `DERIVED_SSS_SCL_SS_DEMO_SUM_LINK`,
`DERIVED_SSS_SCL_SS_NAMES_LINK` y `DERIVED_SSS_SCL_SS_USERPREF_LINK`.

### Inventario del árbol Classic

| Carpeta | Componentes |
|---|---|
| `HCCC_SS_CATALOG` | `SA_LEARNER_SERVICES.CLASS_SEARCH.GBL`, `SA_LEARNER_SERVICES.SSS_BROWSE_CATLG.GBL` |
| `HCCC_ACAD_PLANNING` | `SA_LEARNER_SERVICES.SSS_MY_PLANNER.GBL`, `SA_LEARNER_SERVICES_2.SSR_SSENRL_CART.GBL`, `SA_LEARNER_SERVICES_2.SSS_MY_CRSEHIST.GBL` |
| `HCCC_ENROLLMENT` | `SA_LEARNER_SERVICES.SS_LAM_STD_GR_LST.GBL`, `SA_LEARNER_SERVICES_2.SSR_SSENRL_APPT.GBL`, `SA_LEARNER_SERVICES_2.SSR_SSENRL_LIST.GBL`, `SA_LEARNER_SERVICES.SSR_SSENRL_SCHD_W.GBL`, `SA_LEARNER_SERVICES_2.SSR_SSENRL_CART.GBL`, `SSR_SSENRL_DROP`, `SSR_SSENRL_EDIT`, `SSR_SSENRL_SWAP`, `SSR_SSENRL_GRADE`, `SA_LEARNER_SERVICES_2.SS_SR_MILESTONES.GBL` |
| `HCCC_FINANCES` | `SSF_SS_ACCT_SUMM`, `SS_SF_ACCT_PROFILE`, `SSF_SS_PAYMENT`, `SS_FA_AWARDS`, `SSF_SS_MISC_PUR`, `SSF_BANK_SUMM` |
| `HCCC_PERS_PORTFOLIO` | `SSS_PRSNLDATA_SUMM`, `SS_CC_ADDRESSES`, `SS_CC_NAMES`, `SS_CC_PERS_PHONE`, `SS_CC_EMAIL_ADDR`, `SS_CC_INTERNET_ADR`, `SS_CC_DEMOG_DATA`, `SS_CC_USER_PREF`, `SS_CC_COMM_PREF`, `SS_CC_LANGUAGES`, `SS_CC_LIC_CERT`, `SS_CC_MEMBERSHIPS`, `SS_CC_WORK_EXP`, `SS_CC_EXTRACUR_ACT`, `SS_CC_HONOR_AWARD`, `SS_CC_PUBLICATIONS`, `SS_CC_HOLDS`, `SS_CC_TODOS`, `SS_CC_NTF_PREF` |
| `HCCC_ACADEMIC_RECORDS` | `SA_LEARNER_SERVICES.SS_ENRL_VER_REQ.GBL`, `SA_LEARNER_SERVICES_2.SSS_MY_CRSEHIST.GBL` |
| `HCCC_DEGPROG_GRAD` | `SAA_SS_DPR_ADB`, `SAA_SS_DPR_AAL`, `SS_GRAD_APPLY`, `SSS_GRAD_STATUS` |
| `HCCC_TRANSFER_CREDIT` | `SA_LEARNER_SERVICES.SS_TRCR_RPT.GBL` |
| `HCCC_PE_STUDENT` | carpeta visible sin componentes autorizados observados |

Los nombres sin prefijo en la tabla son componentes Classic dentro de
`SA_LEARNER_SERVICES` o `SA_LEARNER_SERVICES_2`, según el enlace recibido; conservar la
ruta completa descubierta al automatizar, porque componentes homónimos no son
intercambiables.

## Transfer Credit Report

Ruta: `SA_LEARNER_SERVICES.SS_TRCR_RPT.GBL`; formulario `SS_TRCR_RPT`. Tiene tres
bloques colapsables: Course Credits (`DERIVED_TRCR_SS_SSS_TRCR_CRS_LINK`), Test Credits
(`DERIVED_TRCR_SS_SSS_TRCR_TST_LINK`) y Other Credits
(`DERIVED_TRCR_SS_SSS_TRCR_OTH_LINK`).

Para Test Credits, el modelo usa `TEST_MODEL$0` y el detalle `TEST_TRMDTL$0`. Campos:

| Dato | ID base |
|---|---|
| número de modelo | `TRNS_TEST_MOTRM_MODEL_NBR$N` |
| institución | `INSTITUTION_TBL_DESCR$254$$N` |
| career | `ACAD_CAR_TBL_DESCR$264$$N` |
| programa | `ACAD_PROG_TBL_DESCR$268$$N` |
| plan | `ACAD_PLAN_TBL_DESCR$271$$N` |
| término de transferencia | `TEST_TERM$N` |
| test ID | `TRNS_TEST_DTL_TEST_ID$N` |
| componente | `TRNS_TEST_DTL_TEST_COMPONENT$N` |
| score | `TRNS_TEST_DTL_SCORE$N` |
| estado | `TRNS_TEST_A_VW_TRNSFR_STAT$N` |
| curso equivalente | `DERIVED_TRCR_SUBJ_CATLG_INT$294$$N` |
| unidades | `TRNS_TEST_A_VW_UNT_TRNSFR$N` |
| nota | `TRNS_TEST_A_VW_CRSE_GRADE_OFF$N` |

## Componentes personalizados PUCMM

Árbol: `PUC_AUTOSERVICIO` → `PUC_AUTOSERVICIO_ALUMNO`.

| Carpeta | Opción | Componente |
|---|---|---|
| `PUC_AUTOSERVICIO_ALUMNO_REG` | Evaluación Profesoral | `PUC_CUSTOM_CS.PUC_EVAL_DOC_ALU.GBL` |
| `PUC_AUTOSERVICIO_ALUMNO_REG` | Formalizar Inscripción | `PUC_CUSTOM_CS.PUC_REG_STDNT_ENRL.GBL` |
| `PUC_AUTOSERVICIO_ALUMNO_REG` | Mensajes | `PUC_CUSTOM_CS.PUC_CONS_MSG_CATG.GBL` |
| `PUC_AUTOSERVICIO_ALUMNO_CON` | Asistencia | `PUC_CUSTOM_CS.PUC_CONS_ASIS_EST.GBL` |
| `PUC_AUTOSERVICIO_ALUMNO_CON` | Estimación costo | `PUC_CUSTOM_CS.PUC_CONS_COST_STDN.GBL` |
| `PUC_AUTOSERVICIO_ALUMNO_CON` | Estimación índice | `PUC_CUSTOM_CS.PUC_ESTINDACAD_AUT.GBL` |
| `PUC_AUTOSERVICIO_ALUMNO_INF` | Historia Académica Estudiante | `PUC_CUSTOM_CS.PUC_HISACAD_AUTO.GBL` |

### Asistencia

Lista: `PUC_CUSTOM_CS.PUC_CONS_ASIS_EST.GBL`, formulario `PUC_CONS_ASIS_EST`. Cabecera
`TERM_TBL_STRM` y `TERM_TBL_DESCR`; grid `CLASS_TBL_SE_VW`, con filas
`trCLASS_TBL_SE_VW$0_rowN`.

| Dato | ID base |
|---|---|
| campus | `CLASS_TBL_SE_VW_CAMPUS$N` |
| catálogo | `CLASS_TBL_SE_VW_CATALOG_NBR$N` |
| sección | `CLASS_TBL_SE_VW_CLASS_SECTION$N` |
| class number | `CLASS_TBL_SE_VW_CLASS_NBR$N` |
| descripción | `CLASS_TBL_SE_VW_DESCR$N` |
| abrir detalle | `PUC_DERIVED_LINK$N` |
| exportar | `CLASS_TBL_SE_VW$hexcel$0` |

El detalle sigue esta plantilla:

```text
PUC_CUSTOM_CS.PUC_DET_ASIS_EST.GBL?Page=PUC_ASIS_CLS_ESTDT&Action=U&ACAD_CAREER={CAREER}&CLASS_NBR={CLASS_NBR}&EMPLID={EMPLID}&INSTITUTION={INSTITUTION}&STRM={STRM}
```

Formulario `PUC_DET_ASIS_EST`; clase `PUC_ASISCL_SRCH_DESCR1`, descripción
`CLASS_TBL_SE_VW_DESCR`, profesor `PUC_ASISCL_SRCH_NOMBRE_CONDENSADO`, ausencias
permitidas `PUC_DERIVED_CRSE_ATTR_VALUE` y total `PUC_DERIVED_DESCR`. El grid de fechas
es `CLASS_TBL_SE_VW`; fecha `PUC_ASISCL_EST_CLASS_ATTEND_DT$N` y horas asistidas
`PUC_ASISCL_EST_COUNT1$N`. Usar `CLASS_TBL_SE_VW$hviewall$0` para no perder filas.

### Estimación de costo

Ruta/formulario: `PUC_CUSTOM_CS.PUC_CONS_COST_STDN.GBL` / `PUC_CONS_COST_STDN`.
Inputs: `PUC_CONCOST_WRK_STDNT_GROUP`, `PUC_CONCOST_WRK_FLAG1`,
`PUC_CONCOST_WRK_ACAD_CAREER`, `PUC_CONCOST_WRK_ACAD_PROG`,
`PUC_CONCOST_WRK_ACAD_PLAN`, `PUC_CONCOST_WRK_CURRENCY_CD`,
`PUC_CONCOST_WRK_CAMPUS`, `PUC_CONCOST_WRK_EMPLID` y `PUC_CONCOST_WRK_STRM`.

Calcular es `PUC_CONCOST_WRK_CALCULATE_BUTTON`; imprimir es
`PUC_CONCOST_WRK_PRINT_BTN`. El cálculo es POST de solo lectura, no un GET estático.
Salida detallada:

| Dato | ID base |
|---|---|
| período | `PUC_CALEST_VW_DESCR$N` |
| concepto | `ITEM_TYPE_SRCH_DESCR$N` |
| cantidad | `PUC_CALESTDT_VW_MIN_UNITS_REQD$N` |
| costo unitario | `PUC_CALESTDT_VW_PAYOUT_AMT$N` |
| total de fila | `PUC_CALESTDT_VW_TOTAL_AMT$N` |
| total de período | `PUC_CONCOST_WRK_TOTAL_AMT$N` |
| total general | `PUC_CONCOST_WRK_TOTAL_AMT_DUE` |

El resumen paralelo usa `ITEM_TYPE_SRCH_DESCR$44$$N`,
`PUC_CALESTRE_VW_MIN_UNITS_REQD$N`, `PUC_CALESTRE_VW_PAYOUT_AMT$N` y
`PUC_CALESTRE_VW_TOTAL_AMT$N`.

### Estimación de índice

Ruta/formulario: `PUC_CUSTOM_CS.PUC_ESTINDACAD_AUT.GBL`. Grid de cursos
`PUC_EST_IND_DTL`; nota hipotética `PUC_EST_IND_DTL_CRSE_GRADE_INPUT$N`, sustituir
nota `PUC_CSREG73_WRK_PUC_CRSE_ID_SUST$N` y calcular
`PUC_CSREG73_WRK_BUTTON$0`. También muestra estadísticas del término y acumuladas.

Es una calculadora what-if: sus inputs no son calificaciones oficiales. Un scraper puede
leer el estado inicial, pero no debe introducir notas ni publicar resultados como GPA
oficial.

### Mensajes

Ruta/formulario: `PUC_CUSTOM_CS.PUC_CONS_MSG_CATG.GBL`. Filtro
`PUC_GEN_PRM_WRK_PUC_MSG_STATUS`: `Y` leídos, `N` no leídos, `T` todos. Grid
`PUC_MSG_CATG_VW`, marca de leído `PUC_MSG_CATG_VW_READ_DATA$N` y detalle
`PUC_GEN_PRM_WRK_HYPERLINK$N`.

Abrir un mensaje puede marcarlo como leído. Extraer títulos/estados sin abrir o aceptar
explícitamente esa mutación; nunca almacenar el cuerpo real en fixtures.

### Formalizar inscripción

Ruta/formulario: `PUC_CUSTOM_CS.PUC_REG_STDNT_ENRL.GBL`. Es dependiente de fechas y de
clases elegibles. Fuera de ventana muestra un mensaje sin botón de acción. Es un flujo de
escritura académica: detectar disponibilidad es seguro, enviar/formalizar no lo es.

### Evaluación profesoral

Lista: `PUC_CUSTOM_CS.PUC_EVAL_DOC_ALU.GBL`, formulario del mismo nombre, grid
`PUC_EVA_DOC_ALU`. Incluye class number, curso, componente, docente, rol, ciclo, fechas y
estado. La acción pendiente es `VINCULO$N` y lleva a:

```text
PUC_CUSTOM_CS.PUC_EVAL_DOC_ALU2.GBL?Page=PUC_EVAL_DOC_ALU2&Action=U&EMPLID={EMPLID}&PUC_ID_EVAL={PUC_ID_EVAL}
```

El detalle tiene 17 grupos `PUC_EV_DO_D_WRK_PUC_RESP_QUESTION$N`, con valores 1–5 y
`A` para N/A. Preferencia de docente `PUC_EV_DO_H_WRK_PUC_PREF_INSTR`, razón
`PUC_EV_DO_H_WRK_PUC_RSN_INSTR`, comentario `PUC_EV_DO_H_WRK_PUC_COMNT_EVAL`.
`PUC_EV_DO_H_WRK_SUBMIT_PB` envía y `PUC_EV_DO_H_WRK_PUC_NO_EVAL_PB` rechaza evaluar:
ambos son acciones irreversibles y quedan fuera de un scraper.

### Historia Académica Estudiante

Ruta/formulario: `PUC_CUSTOM_CS.PUC_HISACAD_AUTO.GBL` / `PUC_HISACAD_AUTO`. Abre una
búsqueda de run control (`PRCSRUNCNTL_RUN_CNTL_ID`) con `ICSearch` y opción de añadir
valor. Es un proceso batch/report, posiblemente con creación de estado; no es una fuente
HTML directa y no debe ejecutarse durante un scrape normal.

## Jerarquía recomendada de fuentes

| Información | Fuente preferida | Alternativa |
|---|---|---|
| búsqueda/cupo de secciones | `CLASS_SEARCH.GBL` Classic | Class Search Fluid |
| carrito y acciones de matrícula | componentes `SSR_SSENRL_*` Classic | Manage Classes Fluid |
| horario actual | `SSR_SSENRL_SCHD_W.GBL` en lista | View My Classes Fluid |
| horarios pasados | `SS_LAM_STD_GR_LST.GBL` | historial + reuniones si están disponibles |
| notas/historial | Course History Fluid o `SSS_MY_CRSEHIST` | View Grades por término |
| requisitos/pénsum | advisement report Classic | Academic Progress Fluid |
| asistencia | `PUC_CONS_ASIS_EST` + detalle | ninguna equivalente verificada |
| balance/cargos/pagos | Financial Account Fluid | componentes Classic de Finances |
| holds/to-dos | comparar Tasks Fluid y Student Center | componentes `SS_CC_HOLDS`/`SS_CC_TODOS` |
| créditos transferidos | `SS_TRCR_RPT.GBL` | Course History con estado Transferred |
| datos personales | Profile Fluid, solo si es necesario | Personal Information Classic |

## Estados que el crawler debe distinguir

Una ruta puede estar: disponible con datos, disponible vacía, visible pero no autorizada,
dependiente de término, dependiente de ventana institucional, dependiente de navigation
collection o ser un flujo de escritura. Nunca convertir todos esos casos en `[]`.

Detectores útiles:

| Estado | Señal |
|---|---|
| no autorizado | texto “You are not authorized for this page” |
| contexto Fluid ausente | `bIsCalledOutsideNavigationCollection` o error genérico al abrir hoja directa |
| vacío real | mensaje específico dentro del componente y formulario esperado presente |
| sesión vencida | formulario/login en lugar del componente esperado |
| necesita término | radios/lista de `STRM` y botón Continue |
| paginado | controles `$hviewall$`, `$hdown$` o contador de filas |
| acción mutante | Submit, Save, Enroll, Drop, Swap, Formalizar, Payment, evaluación o edición de perfil |

## Estrategia de scraper

1. Autenticar en navegador y verificar landing, sin guardar credenciales ni cookies.
2. Lanzar cada módulo por su URL START para crear el contexto Fluid.
3. Capturar el `action` y estado oculto del formulario de cada hoja.
4. Extraer por IDs semánticos y contención DOM; normalizar `$N` solo al agrupar.
5. Expandir View All o paginar antes de declarar el dataset completo.
6. Clasificar explícitamente autorización, vacío, ventana cerrada y error de sesión.
7. Para fixtures, ejecutar scrub de PII y comprobar que no queden `ICSID`, `EMPLID`,
   nombres ni valores financieros/académicos reales.
8. Mantener una allowlist de acciones de lectura. Bloquear por defecto botones de pago,
   matrícula, formalización, evaluación, edición y procesos batch.

Este mapa cubre todas las entradas visibles de la homepage del estudiante, las hojas de
navegación lateral, el árbol Classic del Centro del Alumnado y los componentes PUCMM
expuestos a la cuenta usada para el recon. Una opción visible pero no autorizada queda
documentada como tal; su HTML interno no puede inferirse de forma segura.
