#!/usr/bin/env node
import 'dotenv/config';
import { configureRuntimePaths } from '../paths.js';

// El entrypoint del servidor MCP sobre stdio.
//
// Este proceso lo lanza el cliente MCP y no el launcher de mikampus, así que
// tiene que cargar el mismo .env que carga el server: sin las llaves VAPID no
// hay push, y sin push no hay código de confirmación. dotenv lee el .env del
// directorio de trabajo, o sea que el cliente MCP tiene que arrancarlo con `cwd`
// puesto (o exportar las llaves él mismo). Si no llegan, el mensaje de arranque
// lo dice en voz alta en vez de fallar recién cuando haya una baja esperando.
//
// configureRuntimePaths corre ANTES de cualquier import que abra la base, por la
// misma razón que lo hace src/launcher.js: las rutas de datos se resuelven una
// sola vez y todo lo que venga después las hereda del entorno.
configureRuntimePaths();

const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const { createMcpServer, registerActions } = await import('./server.js');

// El carril de acción no se enciende por configuración escondida: hace falta una
// bandera explícita al lanzar el proceso. Sin ella las herramientas de acción no
// se listan, y un agente no puede llamar lo que no ve.
const allowActions = process.argv.includes('--allow-actions') || process.env.MIKAMPUS_MCP_ACTIONS === 'on';

const server = createMcpServer({ allowActions });
if (allowActions) await registerActions(server);

// stdout es el canal del protocolo: cualquier console.log lo corrompe. Los
// mensajes de vida van a stderr.
process.stderr.write(`mikampus-mcp listo (${allowActions ? 'lectura + acción' : 'solo lectura'})\n`);

// El estado del canal de confirmación se dice al arrancar y no cuando ya hay una
// baja esperando: sin un teléfono suscrito, el carril de acción está encendido
// pero nada que cambie matrícula se va a poder confirmar.
if (allowActions) {
  const { confirmationChannel } = await import('./tickets.js');
  const channel = confirmationChannel();
  process.stderr.write(
    channel.available
      ? `mikampus-mcp: los códigos de confirmación salen por push a ${channel.devices} dispositivo(s)\n`
      : `mikampus-mcp: SIN canal de confirmación. ${channel.reason} Nada que cambie tu matrícula se va a poder confirmar.\n`
  );
}

await server.connect(new StdioServerTransport());
