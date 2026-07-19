# Deploy hosted en DigitalOcean

La app usa el login normal de cada estudiante de PUCMM. Caddy termina HTTPS;
la autenticación y el aislamiento por usuario viven en mikampus, no en una
contraseña compartida de Basic Auth.

## Antes de publicar

1. En el firewall de DigitalOcean agrega TCP 80 y TCP 443 desde `All IPv4` y
   `All IPv6`. Mantén TCP 22 solo desde tu IP.
2. Crea un A record para `mikampus.decruce.dev` que apunte a la IPv4 del
   Droplet. Espera a que resuelva públicamente antes de arrancar Caddy.
3. En el Droplet instala Docker Engine y el plugin Compose siguiendo la guía
   oficial de Docker para Ubuntu. Verifica con `docker --version` y
   `docker compose version`.

## Configurar y arrancar

Desde `/root/mikampus`:

```bash
cp .env.hosted.example .env.hosted
chmod 600 .env.hosted
openssl rand -hex 32
```

Completa `DOMAIN`, `MIKAMPUS_ALLOWLIST` y pega la salida del comando en
`MIKAMPUS_CRED_KEY`. No subas `.env.hosted` al repositorio ni lo copies a otro
equipo. Una allowlist vacía bloquea todos los logins hosted por seguridad.

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f app caddy
```

Abre `https://mikampus.decruce.dev`. El navegador debe pedir las credenciales
de Basic Auth y Caddy debe mostrar un certificado válido. La app se sirve solo
en la red interna Docker: el puerto 4173 no se publica al Internet.

## Backups Litestream

Antes de activar Litestream, crea un bucket **privado** de DigitalOcean Spaces,
una access key limitada a ese bucket y un par de claves Age. Guarda la identidad
privada de Age fuera del Droplet y fuera del bucket; el recipient público va en
`.env.hosted` como `LITESTREAM_AGE_RECIPIENT`.

Completa las variables `LITESTREAM_*`, cambia `LITESTREAM_ENABLED=true` y
reinicia:

```bash
docker compose up -d --force-recreate app
docker compose logs -f app
```

La configuración replica `/data/mikampus.db` continuamente y retiene 72 horas.
No borres el volumen `mikampus_data` ni el bucket: son los únicos originales y
las copias recuperables, respectivamente.

## Operación segura

Antes del vencimiento del crédito, revisa Billing. No actualices la cuenta a un
plan pago ni dejes el Droplet activo después de que se agote el crédito sin una
decisión explícita sobre costos. Para detener el piloto sin destruir datos:

```bash
docker compose down
```
