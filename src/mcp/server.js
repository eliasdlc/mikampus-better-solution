import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertSchemaReadable } from './db.js';
import { sanitize } from './redact.js';
import { ABOUT_RESOURCE, READ_TOOLS } from './tools.js';

// El armado del servidor MCP, agnóstico del transporte.
//
// Hoy solo se sirve por stdio (src/mcp/stdio.js) porque el valor central es que
// los datos contesten aunque el agente de mikampus esté apagado, y un transporte
// HTTP ataría la lectura a que el agente esté vivo. Montarlo mañana sobre el
// Express que ya existe no cambia nada de este archivo.

export const SERVER_NAME = 'mikampus';
export const SERVER_VERSION = '0.1.0';

function toolResult({ summary, payload }) {
  // La sanitización corre acá, en el único punto por donde salen todas las
  // respuestas: una clave sensible que se cuele en un objeto armado a mano no
  // tiene otra salida por donde escaparse.
  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: sanitize(payload),
  };
}

function errorResult(error) {
  return {
    content: [{ type: 'text', text: sanitize(error instanceof Error ? error.message : String(error)) }],
    isError: true,
  };
}

export function createMcpServer({ allowActions = false, now = () => new Date() } = {}) {
  assertSchemaReadable();

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        'mikampus expone los datos académicos locales de Elias en PUCMM.',
        'Empezá por get_overview. Antes de afirmar algo, mirá freshness y unknown de la respuesta:',
        'lo que aparece en unknown no se sabe y no se estima.',
        allowActions
          ? 'El carril de acción está encendido: propose_action nunca ejecuta, y confirm_action exige el código de 6 dígitos que mikampus le manda por push al teléfono de Elias, fuera de esta conversación.'
          : 'Este servidor es de solo lectura: no puede cambiar nada en el portal.',
      ].join(' '),
    }
  );

  for (const tool of READ_TOOLS) {
    server.registerTool(
      tool.name,
      // readOnlyHint no es decorativo: la conexión a la base se abre sin permiso
      // de escritura, así que ninguna de estas herramientas puede escribir
      // aunque su código quisiera.
      { ...tool.config, annotations: { readOnlyHint: true, openWorldHint: false } },
      (args) => {
        try {
          return toolResult(tool.run({ ...(args ?? {}), now: now() }));
        } catch (error) {
          return errorResult(error);
        }
      }
    );
  }

  server.registerResource(
    'about',
    'mikampus://about',
    {
      title: 'Glosario y límites de mikampus',
      description: 'Qué significan STRM, LEC/PRA, un hold unknown, y la lista de lo que mikampus NO sabe.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: ABOUT_RESOURCE }] })
  );

  return server;
}

// El carril de acción se registra aparte y solo si está encendido. Es una
// función distinta a propósito: sin --allow-actions, src/mcp/actions.js ni
// siquiera se importa, así que el proceso tampoco abre una conexión de
// escritura a la base.
export async function registerActions(server) {
  const { ACTION_TOOLS } = await import('./actions.js');
  for (const tool of ACTION_TOOLS) {
    server.registerTool(
      tool.name,
      { ...tool.config, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
      async (args) => {
        try {
          return toolResult(await tool.run(args ?? {}));
        } catch (error) {
          return errorResult(error);
        }
      }
    );
  }
  return ACTION_TOOLS.map((tool) => tool.name);
}
