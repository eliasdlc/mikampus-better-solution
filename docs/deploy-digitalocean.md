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

Completa `DOMAIN`, `MIKAMPUS_EXPECTED_IPV4`, `MIKAMPUS_ALLOWLIST`, las claves
VAPID, el topic privado de ntfy y pega la salida del comando en
`MIKAMPUS_CRED_KEY`. No subas `.env.hosted` al repositorio ni lo copies a otro
equipo. Una allowlist vacía bloquea todos los logins hosted por seguridad.

Antes de arrancar, el gate local valida que no falte ninguna pieza de la
instancia hosted, sin imprimir secretos:

Antes de ese gate, crea el bucket privado, las claves limitadas y el recipient
Age siguiendo [LITESTREAM-SETUP.md](./LITESTREAM-SETUP.md). Completa
`LITESTREAM_*` y deja `LITESTREAM_ENABLED=true`: la beta no se abre sin una
réplica cifrada y restaurable.

```bash
node --env-file=.env.hosted scripts/check-launch-readiness.mjs
```

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f app caddy
```

Abre `https://mikampus.decruce.dev`. Caddy espera a que `/api/health` de la
app esté sano antes de arrancar; luego debe emitir un certificado válido. No
hay Basic Auth: cada estudiante entra con su propia cuenta de micampus y la
allowlist limita quién siquiera puede intentar ese login. La app se sirve solo
en la red interna Docker: el puerto 4173 no se publica al Internet.

Cuando DNS y TLS ya resolvieron públicamente, valida el deploy:

```bash
node --env-file=.env.hosted scripts/check-launch-readiness.mjs --online
```

## Confirmar backups Litestream

La configuración replica `/data/mikampus.db` continuamente y retiene 72 horas.
Tras arrancar, confirma en los logs y en Spaces que la réplica existe, y realiza
una restauración temporal como indica [LITESTREAM-SETUP.md](./LITESTREAM-SETUP.md).
No borres el volumen `mikampus_data` ni el bucket: son los únicos originales y
las copias recuperables, respectivamente.

## Operación segura

Antes del vencimiento del crédito, revisa Billing. No actualices la cuenta a un
plan pago ni dejes el Droplet activo después de que se agote el crédito sin una
decisión explícita sobre costos. Para detener el piloto sin destruir datos:

```bash
docker compose down
```
