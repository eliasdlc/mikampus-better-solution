import readline from 'node:readline';
import { loginToPeopleSoft } from './login.js';

// El login de los recon.
//
// `loginToPeopleSoft` exige credenciales explícitas desde que la cuenta salió
// del .env: la contraseña vive en RAM mientras dura una sesión interactiva, o
// en el vault cifrado cuando autorizás una función desatendida. Los recon no
// son ninguna de las dos cosas, así que quedaron llamándolo sin argumentos y
// fallando todos con "No hay cuenta configurada".
//
// La respuesta correcta no es volver a leer del .env: es preguntar en el
// momento, que es exactamente lo que el comentario de login.js pide ("la
// credencial se entrega explícitamente desde un caller interactivo"). La
// contraseña no se guarda, no se ecoa y no toca disco.

// Una SOLA interfaz para las dos preguntas. Crear una por pregunta cuelga la
// segunda: al cerrar la primera, readline deja de emitir líneas sobre ese mismo
// stdin y el await no vuelve nunca. El síntoma es el peor posible, un proceso
// colgado justo después de pedir la contraseña.
//
// `output: process.stderr` deja stdout limpio: la salida de un recon se suele
// redirigir a un archivo y el prompt no tiene por qué terminar ahí adentro.
function preguntar(rl, pregunta, { oculto = false } = {}) {
  return new Promise((resolve) => {
    const escribir = rl._writeToOutput.bind(rl);
    // Ocultar el eco es reemplazar el escritor de readline mientras dura la
    // pregunta, y devolverlo después: si se deja puesto, todo lo que readline
    // imprima a partir de ahí desaparece.
    if (oculto) rl._writeToOutput = (str) => escribir(str.includes(pregunta) ? str : '');
    rl.question(pregunta, (respuesta) => {
      if (oculto) {
        rl._writeToOutput = escribir;
        process.stderr.write('\n');
      }
      resolve(respuesta.trim());
    });
  });
}

/**
 * Pide usuario y contraseña por consola. El usuario se propone desde
 * PUCMM_USERNAME si está seteado, porque no es un secreto; la contraseña nunca
 * se lee del entorno, para que no quede en el historial del shell ni en la
 * lista de procesos.
 */
export async function askCredentials() {
  if (!process.stdin.isTTY) {
    throw new Error('Los recon piden la contraseña por consola: corrélos en una terminal interactiva');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    const porDefecto = process.env.PUCMM_USERNAME ?? '';
    const username = (await preguntar(rl, `Usuario de micampus${porDefecto ? ` [${porDefecto}]` : ''}: `)) || porDefecto;
    if (!username) throw new Error('Hace falta el usuario');
    const password = await preguntar(rl, 'Contraseña (no se guarda): ', { oculto: true });
    if (!password) throw new Error('Hace falta la contraseña');
    return { username, password };
  } finally {
    rl.close();
  }
}

/**
 * Abre una sesión de recon con las credenciales que se acaban de tipear.
 *
 * Sale del proceso con el motivo en vez de propagar el error, y no es pereza:
 * la mitad de los recon hacen `await` en el nivel superior del módulo, donde
 * una excepción se convierte en "Warning: Detected unsettled top-level await"
 * y el motivo real no se imprime. Estos módulos son entrypoints de consola, no
 * librería: acá el lugar correcto para terminar es este.
 */
export async function loginForRecon(options = {}) {
  try {
    const { username, password } = await askCredentials();
    return await loginToPeopleSoft({ headless: true, ...options, username, password });
  } catch (error) {
    console.error(`recon: ${error.message}`);
    process.exit(1);
  }
}
