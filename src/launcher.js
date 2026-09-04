#!/usr/bin/env node
// This is deliberately the only production entrypoint: paths must be fixed
// before `db.js` or Playwright are evaluated. Static imports cannot guarantee
// that ordering across their dependency graph.
import { configureRuntimePaths } from './paths.js';
import { CLI_COMMANDS, isCliCommand } from './cliCommands.js';

configureRuntimePaths();

// Sin argumentos se levanta el agente: es el entrypoint de `npx mikampus` y de
// la unidad de systemd, y ninguno de los dos pasa un subcomando.
//
// Con un subcomando conocido va al CLI. Antes el único reconocido era la
// palabra literal `cli`, así que `mikampus stop` no matcheaba, caía al server y
// ARRANCABA un agente: el comando cuyo nombre promete lo contrario. Peor, ese
// agente nuevo chocaba con el lock del que ya corría y moría dejando un evento
// de runtime suelto, así que el síntoma era "no pasó nada" y el proceso viejo
// seguía sirviendo código viejo.
//
// `cli` se conserva como alias por los scripts y la documentación que ya lo
// usan. Un argumento desconocido es un error explícito y no un arranque
// silencioso: equivocarse de comando no puede levantar un proceso de fondo.
const first = process.argv[2];

if (first === 'cli') {
  process.argv.splice(2, 1);
  await import('./cli.js');
} else if (isCliCommand(first)) {
  await import('./cli.js');
} else if (first != null) {
  console.error(`mikampus: comando desconocido: ${first}`);
  console.error(`Comandos: ${CLI_COMMANDS.join(', ')}`);
  console.error('Sin comando, mikampus arranca el agente en primer plano.');
  process.exit(1);
} else {
  await import('./server.js');
}
