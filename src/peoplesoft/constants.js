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

export const CONTENT_FRAME_NAME = 'TargetContent';
