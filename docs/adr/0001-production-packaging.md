# ADR 0001: payload Node por plataforma para el primer artefacto

**Estado:** aceptado para el spike de Fase 3 (2026-07-22).

## Contexto

El backend usa ESM, `node:sqlite`, imports TypeScript en source y Playwright,
que localiza su paquete y sus browsers en runtime. La distribución no puede
escribir SQLite, secretos, logs ni browsers en el CWD o junto al ejecutable.

## Evidencia del spike

- Node `v26.2.0` generó y ejecutó un SEA mínimo con `node --build-sea`; al
  ejecutarlo emitió `ExperimentalWarning`. SEA no empaqueta automáticamente
  los módulos ESM externos, la resolución dinámica de Playwright ni sus
  browsers/assets.
- `@yao-pkg/pkg` `6.21.0` está disponible, pero añade un runtime alterno y no
  resolvió esas dependencias dinámicas en este spike.
- Bun no fue seleccionado: no se probó compatibilidad end-to-end con
  `node:sqlite`, el keyring nativo y el lifecycle de servicio. No se acepta
  por promesa de compatibilidad.
- El artifact generado en Linux x64 contiene bundle ESM, SPA, avisos y sólo
  dependencias de producción: **99 MiB** en disco (83,209,181 bytes antes de
  instalar Chromium). La SPA es 173.42 KiB gzip; Chromium no está incluido.

## Decisión

La vía standalone inicial es un payload por OS/CPU que incluye el runtime Node
compatible, el bundle ESM y dependencias de producción. Este repo genera y
smokea el payload de aplicación; el instalador de Fase 5 añadirá el runtime
Node y firma/notarización cuando P3 esté resuelta. El paquete npm conserva
Node >=24 como prerequisito de desarrollador.

`scripts/build-production.mjs` compila la SPA y el backend con esbuild, pero
deja los paquetes de runtime externos para que Playwright y módulos nativos
mantengan su layout. `src/launcher.js` fija las rutas antes de importar SQLite
o Playwright. `src/paths.js` es la única fuente de rutas:

| Plataforma | app-data por defecto |
|---|---|
| Windows | `%APPDATA%\\mikampus` |
| macOS | `~/Library/Application Support/mikampus` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/mikampus` |

`MIKAMPUS_DATA_DIR` reemplaza esa root y es la ruta para el volumen persistente
de Home Server. DB, vault, backups, lock y browsers quedan debajo de ella.

## Consecuencias

- SEA y Bun se mantienen fuera del release inicial. Se pueden reconsiderar con
  un artifact smoke equivalente en cada target.
- Chromium se descarga en primer uso a `app-data/browsers`, nunca se bundlea.
  `mikampus install-browser` muestra la salida de Playwright, propaga
  cancelación y reintenta una vez los errores transitorios. Proxy, CA custom y
  sus variables estándar de Node/Playwright se transmiten al proceso hijo.
- La recolección de versiones de browser no se automatiza todavía: Playwright
  administra versiones compatibles; borrar una versión puede romper un agente
  en ejecución. La política de GC se definirá con el updater de Fase 5.

## Matriz cerrada para el primer release candidate

| Target | Estado |
|---|---|
| Linux x64, Node 24+, Ubuntu 24.04 / Debian 12 | **Soportado y smokeado** |
| Windows x64 | Diferido: requiere smoke nativo y decisión P3 de firma |
| macOS ARM64/x64 | Diferido: requiere smoke nativo y notarización P3 |
| Linux ARM64 / Windows ARM64 | No soportado en RC1; requiere smoke y browser compatible |

“Linux” no significa cualquier distribución: el soporte inicial se limita a
Ubuntu 24.04 y Debian 12 x64 una vez que el pipeline de Fase 6 ejecute ambos.
