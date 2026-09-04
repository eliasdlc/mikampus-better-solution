// Importar este módulo configura las rutas de runtime como efecto de import.
//
// launcher.js puede llamar a configureRuntimePaths() imperativamente porque
// controla su orden: importa paths.js, la llama, y recién ahí importa el resto
// con `await import`. Un script con imports estáticos no tiene esa opción — ESM
// evalúa todos los imports antes de la primera sentencia del cuerpo — así que
// para él la única forma de fijar las rutas a tiempo es que otro import lo haga.
//
// Sin esto, un script termina hablando con rutas por defecto en vez de las de la
// app: la base de datos equivocada y el browser buscado en el cache global de
// Playwright en vez del que mikampus administra. Falla tarde y confuso.
//
// Importalo PRIMERO, y después de `dotenv/config` si el script lee .env: lo que
// venga del .env (MIKAMPUS_DATA_DIR y compañía) tiene que estar en el entorno
// antes de que se resuelvan las rutas derivadas.
import { configureRuntimePaths } from './paths.js';

configureRuntimePaths();
