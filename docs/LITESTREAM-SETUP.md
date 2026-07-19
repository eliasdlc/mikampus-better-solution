# Completar Litestream en Fase 1

## Contexto

Litestream replica continuamente `mikampus.db` a un bucket S3-compatible (DigitalOcean Spaces) con cifrado Age. El recipient público (que va en `.env.hosted`) es visible; la identidad privada (que descifra) se guarda **fuera del Droplet y fuera del bucket** por seguridad.

## Pasos en DigitalOcean Console

### 1. Crear bucket privado de Spaces

1. Ve a **Spaces** en la consola de DigitalOcean.
2. Haz clic en **Create a new space**.
3. Nombre: `mikampus-litestream` (o similar).
4. Region: **New York (nyc1)** (misma del Droplet).
5. **Deselecciona** "Make it public" (debe quedar **privado**).
6. Crea el bucket.

### 2. Crear access key limitado a ese bucket

1. Ve a **API** > **Spaces Keys** en la consola.
2. Haz clic en **Generate New Key**.
3. Nombre: `mikampus-litestream`.
4. Asegurate de que la clave está limitada solo a `mikampus-litestream` (no a todos los buckets).
5. Copia:
   - Access Key ID
   - Secret Access Key

**Guarda estas credenciales en un lugar seguro fuera del Droplet.** No las pegues en el chat ni en un archivo local sin cifrar.

## Pasos en el Droplet

Conéctate al Droplet usando la IPv4 reservada configurada para `DOMAIN`:

```bash
ssh -i <tu-clave> root@<ipv4-reservada>
cd /root/mikampus
```

### 1. Crear y guardar la identidad Age (identidad privada)

La identidad privada debe estar **fuera del Droplet**, fuera del bucket y fuera
del repositorio. Créala en una máquina confiable; no copies una clave desde este
documento:

```bash
age-keygen -o ~/.config/litestream-age-identity.txt
chmod 600 ~/.config/litestream-age-identity.txt
```

El comando imprime el recipient público (`age1...`); ese es el único valor que
va en `LITESTREAM_AGE_RECIPIENT`.

**Nunca subas la identidad al Droplet, nunca la commits y nunca la pases por
chat.** Si una identidad se expone, genera un par nuevo y actualiza el recipient
antes de activar la réplica.

### 2. Completar `.env.hosted` en el Droplet

En el Droplet, edita `/root/mikampus/.env.hosted` con los valores:

```bash
nano /root/mikampus/.env.hosted
```

Busca y completa:

```
LITESTREAM_ENABLED=true
LITESTREAM_BUCKET=mikampus-litestream
LITESTREAM_ENDPOINT=https://nyc1.digitaloceanspaces.com
LITESTREAM_ACCESS_KEY_ID=<pega tu Access Key ID aquí>
LITESTREAM_SECRET_ACCESS_KEY=<pega tu Secret Access Key aquí>
LITESTREAM_AGE_RECIPIENT=<recipient público age1... generado en el paso 1>
```

Guarda con Ctrl+O, Enter, Ctrl+X.

### 3. Reiniciar app con Litestream habilitado

```bash
docker compose up -d --force-recreate app
docker compose logs -f app
```

Espera a que Litestream inicie. Deberías ver logs como:

```
app       | INFO litestream: replica: <bucket>: sync starting
app       | INFO litestream: replica: <bucket>: snapshot written
```

Presiona Ctrl+C para salir de los logs.

### 4. Verificar que la réplica se escriba en Spaces

```bash
# Desde el Droplet, lista archivos en el bucket (si tienes aws-cli)
# O simplemente espera 1-2 minutos y revisa en la consola de DigitalOcean Spaces
```

Desde la consola de DigitalOcean, entra a tu bucket `mikampus-litestream`. Deberías ver un objeto llamado `mikampus.db` (potencialmente dentro de un timestamp).

### 5. Probar restauración (sin tocar DB activa)

La restauración requiere la identidad privada, que no vive en el Droplet. Haz
esta prueba desde la máquina confiable que la guarda, o cópiala de forma
temporal al Droplet, restaura y bórrala antes de cerrar la sesión. No dejes una
identidad privada dentro del contenedor ni en el volumen de la aplicación.

Restaura sobre un archivo temporal que no sea la base activa:

```bash
litestream restore -o /tmp/restore-test.db s3://<bucket-name>/mikampus.db \
  -s "$LITESTREAM_ACCESS_KEY_ID" \
  -k "$LITESTREAM_SECRET_ACCESS_KEY" \
  --age-identity ~/.config/litestream-age-identity.txt
```

Verifica que el archivo de prueba existe:

```bash
ls -lh /tmp/restore-test.db
```

Borra el archivo de prueba:

```bash
rm /tmp/restore-test.db
```

## Resumen final para Fase 1

Cuando se completen los pasos anteriores:

1. ✅ Bucket privado creado en Spaces.
2. ✅ Access key limitado creado.
3. ✅ Age identity privada guardada **fuera del Droplet**.
4. ✅ `.env.hosted` completado con `LITESTREAM_ENABLED=true`.
5. ✅ Réplica continua escribiéndose en Spaces, con snapshot diario.
6. ✅ Restauración temporal probada antes de depender de ella.

Entonces Fase 1 se considera **completa** y lista para mergear a `dev`.

## Seguridad

- Nunca expongas `LITESTREAM_ACCESS_KEY_ID` ni `LITESTREAM_SECRET_ACCESS_KEY` en logs públicos.
- La identidad privada Age debe estar **fuera del Droplet**, preferentemente en tu máquina local bajo `~/.config/` con permisos `600`.
- Si necesitas restaurar en el futuro, tendrás que traer la identidad privada al Droplet **temporalmente** (ej: vía `scp`), descifrar, y borrar inmediatamente.
- DigitalOcean Spaces es S3-compatible pero privado; el bucket mismo no es accesible sin credenciales válidas.
