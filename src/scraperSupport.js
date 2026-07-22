// Un release de compatibilidad puede fijar esta variable en su launcher o
// servicio cuando el portal cambió y una acción mutante dejaría el estado
// académico en duda. Las lecturas y todos los datos locales siguen disponibles.
export function requireScraperMutationSupport() {
  if (process.env.MIKAMPUS_SCRAPER_MUTATIONS !== 'blocked') return;
  throw new Error('Esta versión de mikampus ya no es compatible con el portal para acciones que cambian matrícula. Actualizá a una versión corregida; tus datos locales no se borrarán.');
}
