# Fase 0 — validación de supuestos hosted

Esta fase decide si el modo hosted es viable. No se debe abrir el DNS público ni construir el modo multiusuario hasta que los cuatro checks estén documentados como aprobados.

## 1. Probar PeopleSoft desde DigitalOcean

En un Droplet Ubuntu 24.04 limpio de 2GB/1 vCPU, instala Node, clona esta rama, ejecuta `npm ci`, `sudo npx playwright install-deps chromium` y `npm run install-browsers`. Copia `.env.example` a `.env` y completa las credenciales **solo en el Droplet**. No copies `data/` ni subas `.env`. El piloto usa el crédito del GitHub Student Developer Pack; confirma el saldo y que no haya upgrade automático antes de crear recursos.

Primero verifica que el comando no toca el portal:

```bash
npm run validate:hosted-portal
```

Luego, con autorización consciente para generar los logins reales, corre cinco logins secuenciales con jitter de hasta 90 segundos:

```bash
PHASE0_CONFIRM_LIVE=true npm run validate:hosted-portal
```

El reporte incluye la IP pública de salida, timestamps, duración y el resultado de cada intento; nunca imprime usuario ni contraseña. Guarda ese output fuera del repositorio. Aprueba este punto solo si los cinco logins llegan al landing de PeopleSoft sin challenge, bloqueo ni degradación visible. Si falla por la IP de DigitalOcean, el plan hosted se detiene y el fallback es el modo local open source; no se deben reintentar logins en bucle.

## 2. Change Term y límite de resultados

Estos dos supuestos ya están fijados con HTML sanitizado del portal y deben mantenerse verdes antes del deploy:

```bash
node scripts/test-schedule-parser.mjs
node scripts/test-catalog-parser.mjs
```

El primero cubre la selección explícita de término por STRM y etiqueta. El segundo confirma que una búsqueda amplia devuelve el aviso de más de 50 secciones, por lo que el catálogo debe seguir troceando consultas y nunca prometer una lectura total en una sola búsqueda.

## 3. Horas de inscripción y MFA

Registra para cada escuela piloto la fuente de su appointment, zona horaria y si PeopleSoft muestra la hora exacta. El fixture actual de Enrollment Appointments confirma que la pantalla puede publicar fechas, pero el plan no debe inventar una hora cuando el portal no la entregue. Confirma también que el login no solicita MFA; si aparece, las funciones desatendidas se posponen.

## Criterio de salida

La Fase 0 queda lista cuando existe evidencia fechada de: cinco logins correctos desde la IP de DigitalOcean, selección de término comprobada, límite de 50 confirmado, y appointments/MFA revisados para la escuela piloto. La creación del bucket de backups, DNS, Caddy y el deploy pertenecen a la Fase 1.
