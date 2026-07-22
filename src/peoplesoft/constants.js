export const CART_URL =
  'https://micampus.pucmm.edu.do/psp/cs92pro/EMPLOYEE/SA/c/SA_LEARNER_SERVICES.SSR_SSENRL_CART.GBL?FolderPath=PORTAL_ROOT_OBJECT.CO_EMPLOYEE_SELF_SERVICE.HCCC_ENROLLMENT.HC_SSR_SSENRL_CART_GBL&IsFolder=false&IgnoreParamTempl=FolderPath%2cIsFolder';

export const CLASS_SEARCH_URL =
  'https://micampus.pucmm.edu.do/psp/cs92pro/EMPLOYEE/SA/c/SA_LEARNER_SERVICES.CLASS_SEARCH.GBL?PORTALPARAM_PTCNAV=HC_CLASS_SEARCH&EOPP.SCNode=SA&EOPP.SCPortal=EMPLOYEE&EOPP.SCName=HCCC_SS_CATALOG&EOPP.SCLabel=Class%20Search%20%2f%20Browse%20Catalog&EOPP.SCPTfname=HCCC_SS_CATALOG&FolderPath=PORTAL_ROOT_OBJECT.CO_EMPLOYEE_SELF_SERVICE.HCCC_SS_CATALOG.HC_CLASS_SEARCH&IsFolder=false';

// Browse Course Catalog: pantalla hermana del Class Search en la misma carpeta
// del portal (HCCC_SS_CATALOG, "Class Search / Browse Catalog"). Lista los
// subjects y sus materias con título — el diccionario código→título que el
// Class Search no da.
export const BROWSE_CATALOG_URL =
  'https://micampus.pucmm.edu.do/psp/cs92pro/EMPLOYEE/SA/c/SA_LEARNER_SERVICES.SSS_BROWSE_CATLG.GBL?PORTALPARAM_PTCNAV=HC_SSS_BROWSE_CATLG&EOPP.SCNode=SA&EOPP.SCPortal=EMPLOYEE&EOPP.SCName=HCCC_SS_CATALOG&EOPP.SCLabel=Class%20Search%20%2f%20Browse%20Catalog&EOPP.SCPTfname=HCCC_SS_CATALOG&FolderPath=PORTAL_ROOT_OBJECT.CO_EMPLOYEE_SELF_SERVICE.HCCC_SS_CATALOG.HC_SSS_BROWSE_CATLG&IsFolder=false';

// Mi Horario (horario inscrito). Mismo patrón de URL clásica que el carrito:
// el componente vive bajo SA_LEARNER_SERVICES y pide elegir término antes de
// mostrar la grilla.
export const SCHEDULE_URL =
  'https://micampus.pucmm.edu.do/psp/cs92pro/EMPLOYEE/SA/c/SA_LEARNER_SERVICES.SSR_SSENRL_SCHD_W.GBL?FolderPath=PORTAL_ROOT_OBJECT.CO_EMPLOYEE_SELF_SERVICE.HCCC_ENROLLMENT.HC_SSR_SSENRL_SCHD_W_GBL&IsFolder=false&IgnoreParamTempl=FolderPath%2cIsFolder';

// Ver Mi Horario (visor de solo lectura, componente LAM). Distinto de
// SCHEDULE_URL: aquel (SSR_SSENRL_SCHD_W) vive dentro del flujo de inscripción y
// su selector de término solo ofrece ciclos abiertos para inscribir, así que no
// muestra el ciclo en curso ni los pasados. Este componente (SS_LAM_STD_GR_LST,
// bajo "Inscripciones") es el visor: no está atado a citas de inscripción, así
// que sirve para consultar el horario real de cualquier ciclo, actual o pasado.
export const VIEW_SCHEDULE_URL =
  'https://micampus.pucmm.edu.do/psp/cs92pro/EMPLOYEE/SA/c/SA_LEARNER_SERVICES.SS_LAM_STD_GR_LST.GBL?PORTALPARAM_PTCNAV=HC_SS_LAM_STD_GR_LST_GBL1&EOPP.SCNode=SA&EOPP.SCPortal=EMPLOYEE&EOPP.SCName=HCCC_ENROLLMENT&EOPP.SCLabel=Inscripciones&EOPP.SCPTfname=HCCC_ENROLLMENT&FolderPath=PORTAL_ROOT_OBJECT.CO_EMPLOYEE_SELF_SERVICE.HCCC_ENROLLMENT.HC_SS_LAM_STD_GR_LST_GBL1&IsFolder=false';

// View My Classes (Fluid). El horario REAL de cualquier ciclo inscrito —actual
// o pasado— con día/hora/aula/profesor. A diferencia de SCHEDULE_URL
// (SSR_SSENRL_SCHD_W, atado a la ventana de inscripción y por eso ciego al ciclo
// en curso) y de VIEW_SCHEDULE_URL (SS_LAM_STD_GR_LST, el gradebook, que lista
// materias por ciclo pero SIN reuniones), esta hoja Fluid trae la grilla real y
// un selector de todos los ciclos inscritos. Ver MAPA-MICAMPUS.md → Manage
// Classes → "View My Classes".
//
// Es Fluid: abrir la hoja directa en una sesión fresca puede tirar
// `bIsCalledOutsideNavigationCollection` (MAPA §68-72). La ruta robusta es
// lanzar primero el START del tile Manage Classes para crear el navigation
// collection, y recién ahí abrir la hoja. Por eso van las dos URLs.
export const MANAGE_CLASSES_START_URL =
  'https://micampus.pucmm.edu.do/psc/cs92pro_newwin/EMPLOYEE/SA/c/SSR_STUDENT_FL.SSR_START_PAGE_FL.GBL?GMenu=SSR_STUDENT_FL&GComp=SSR_START_PAGE_FL&GPage=SSR_START_PAGE_FL&scname=CS_SSR_MANAGE_CLASSES_NAV';

export const VIEW_MY_CLASSES_URL =
  'https://micampus.pucmm.edu.do/psc/cs92pro/EMPLOYEE/SA/c/SSR_STUDENT_FL.SSR_COMPONENT_FL.GBL?Page=SSR_VW_CLASS_FL&pslnkid=CS_S201605040129258749603935';

// Dar de baja una materia (plan §5.5). Mismo patrón de URL clásica que el
// carrito y Mi Horario, en la misma carpeta de Enrollment del portal.
// Recon cerrado en Fase 8.5: el flujo vive en dropClass.js con fixtures de
// ambos pasos (recon-drop-landing / recon-drop-paso2-confirmacion).
export const DROP_URL =
  'https://micampus.pucmm.edu.do/psp/cs92pro/EMPLOYEE/SA/c/SA_LEARNER_SERVICES.SSR_SSENRL_DROP.GBL?FolderPath=PORTAL_ROOT_OBJECT.CO_EMPLOYEE_SELF_SERVICE.HCCC_ENROLLMENT.HC_SSR_SSENRL_DROP_GBL&IsFolder=false&IgnoreParamTempl=FolderPath%2cIsFolder';

export const CONTENT_FRAME_NAME = 'TargetContent';
