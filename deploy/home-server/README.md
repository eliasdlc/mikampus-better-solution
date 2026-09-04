# Home Server (single-user)

Este despliegue corre una sola instancia para una sola cuenta, guarda SQLite y
el runtime en un volumen local y escucha exclusivamente en `127.0.0.1`.

Acceso recomendado desde otra máquina:

```sh
ssh -L 4173:127.0.0.1:4173 usuario@home-server
```

Luego abrí `http://127.0.0.1:4173`. No expongas el puerto con port forwarding.
Para LAN se requiere un reverse proxy HTTPS y la capa de pairing/admin todavía
no está distribuida; por eso este modo la rechaza por diseño.

## Compose

1. Creá `agent-token.txt` con un valor aleatorio y permisos `0600`.
2. Ajustá la imagen de release en `compose.yaml`.
3. Ejecutá `docker compose up -d`.
4. Respaldá con `docker compose exec mikampus mikampus backup`; restaurar exige
   detener el agente primero para no copiar una DB activa.

El volumen `mikampus-data` es el dato durable. Para RC1, la única plataforma
publicada y smokeada es Linux x64 (Ubuntu 24.04/Debian 12). Una imagen ARM64 no
se declara soportada hasta tener su build e installation smoke nativos; ver la
[matriz de plataformas](../../docs/platform-support.md).

## Avisos: qué sale de este equipo

Un servidor doméstico no tiene escritorio, así que **no hay notificación
nativa**. El transporte base es el feed local que la UI muestra; nada de eso
abandona la máquina.

Si querés que un aviso llegue a tu teléfono, hay que encender un adaptador
externo en *Ajustes → Avisos hacia afuera*. Cada uno se agrega **apagado** y
muestra antes de encenderse a dónde va, de qué servicio depende y el payload
exacto que envía:

| Adaptador | Destino | Payload |
| --- | --- | --- |
| ntfy | El servidor ntfy que indiques (self-hosted o `ntfy.sh`) | Título, texto corto, urgencia y enlace a `localhost` |
| Webhook | La URL que indiques | El mismo objeto en JSON |

El payload nunca incluye tu credencial, tus notas ni el `class_nbr` real, y el
enlace apunta a `127.0.0.1`: fuera de tu red no abre nada. Si usás `ntfy.sh`, el
mensaje pasa por un tercero — eso es tráfico externo declarado y es tu decisión.

## Copias, updates y salida

- `mikampus backup` crea una copia verificada; `mikampus backup --to /ruta` la
  exporta a otro disco. Una copia en el mismo volumen no cubre robo ni daño
  físico.
- `mikampus restore <archivo>` verifica integridad y versión de esquema antes de
  sobrescribir, y exige el agente detenido.
- Un cambio de esquema saca una copia `pre-upgrade-*` antes de migrar. Si la
  migración falla, el mensaje dice qué archivo restaurar.
- `mikampus update` consulta versiones solo cuando vos lo pedís. No hay chequeo
  automático.
- `mikampus erase-data` muestra primero todo lo que borraría; agregá `--yes`
  para confirmar y `--keep-backups` para conservar las copias.
