#!/usr/bin/env node
// El servidor MCP es un segundo entrypoint y no un subcomando del agente: un
// cliente MCP lanza un proceso y habla por stdio con él, así que tiene que poder
// arrancar solo, sin levantar el agente ni abrir un puerto.
//
// Los argumentos llegan por process.argv, así que el carril de acción se
// enciende agregando --allow-actions a la línea de comando del cliente MCP. Sin
// esa bandera el proceso es de solo lectura.
import '../dist/app/mcp/stdio.js';
