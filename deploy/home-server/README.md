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

El volumen `mikampus-data` es el dato durable. Funciona en x64 y ARM64 solo
cuando se use una imagen publicada para esa arquitectura; la matriz final se
cierra durante el spike de Fase 3.
