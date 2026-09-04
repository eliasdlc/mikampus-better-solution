// Los subcomandos que entiende el CLI.
//
// Viven en su propio módulo, sin efectos secundarios, porque los necesitan dos
// lugares que no se pueden importar entre sí: `launcher.js` tiene que decidir
// qué proceso arrancar ANTES de importar nada pesado, y `cli.js` tiene que
// validar contra exactamente la misma lista.
//
// Que estuvieran solo dentro de cli.js es lo que hacía que `mikampus stop`
// arrancara un agente: el launcher no reconocía la palabra, caía al server, y
// el comando más peligroso de equivocar hacía justo lo contrario de su nombre.
export const CLI_COMMANDS = [
  'version',
  'start',
  'stop',
  'status',
  'open',
  'doctor',
  'install-browser',
  'install-service',
  'uninstall-service',
  'backup',
  'restore',
  'erase-data',
  'uninstall',
  'diagnostics',
  'update',
];

export function isCliCommand(value) {
  return typeof value === 'string' && CLI_COMMANDS.includes(value);
}
