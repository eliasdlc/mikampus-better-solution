# Contribuir a mikampus

Gracias por mejorar una herramienta local. Este proyecto no acepta cambios que
introduzcan un servicio hosted, datos centralizados de estudiantes, telemetría o
credenciales de terceros.

## Antes de abrir un cambio

1. Usa una rama creada desde `dev` y mantén los commits pequeños, con formato
   Conventional Commits.
2. No uses cuentas, credenciales, páginas crudas, capturas ni datos académicos
   reales. Los fixtures deben ser fragmentos sintéticos mínimos y registrarse en
   `fixtures/manifest.json`; lee la [política de fixtures](docs/fixtures-policy.md).
3. Antes de cambiar un scraper, realiza recon local y conserva solo el DOM
   sintético que hace falta para el selector. Nunca subas el resultado de recon.
4. Ejecuta `npm test`, `npm run typecheck`, `npm run lint` y
   `npm run audit:public`. Si afecta distribución, ejecuta también el smoke
   correspondiente al artefacto.

## Desarrollo

Node 24 o superior es obligatorio. `npm install`, `npm run build` y `npm start`
levantan el entorno local. El servidor se limita a loopback: no lo expongas a
una LAN o Internet. Reporta vulnerabilidades por el canal privado indicado en
[SECURITY.md](SECURITY.md), no en un issue público.

Al proponer un cambio, explica el comportamiento, riesgos para datos/egress y
la validación ejecutada. Los cambios de UX deben conservar los avisos de cuenta
propia, límites de energía del equipo y ausencia de afiliación con PUCMM.
