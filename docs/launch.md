# Histórico — lanzamiento hosted (no ejecutar)

> Este procedimiento corresponde al prototipo multiusuario. Se conserva como
> registro histórico, no como guía operativa; no invites usuarios ni despliegues
> esta configuración. Ver [`local-security.md`](./local-security.md).

Esta fase prepara la instancia para los primeros compañeros. No convierte un
check técnico en permiso para abrir DNS, guardar credenciales de terceros ni
mandar invitaciones: esas acciones se ejecutan conscientemente por el operador.

## Gate técnico antes de publicar

En el Droplet, con `.env.hosted` configurado y permisos `600`:

```bash
node --env-file=.env.hosted scripts/check-launch-readiness.mjs
docker compose up -d --build
docker compose ps
node --env-file=.env.hosted scripts/check-launch-readiness.mjs --online
```

El primer comando verifica, sin mostrar valores, que la instancia hosted tenga:

- allowlist, clave AES del vault, VAPID y el fallback privado ntfy;
- `TZ=America/Santo_Domingo`;
- Litestream cifrado y con retención de 72 horas;
- la IPv4 reservada que debe resolver el DNS definitivo.

El segundo gate confirma desde la red que el A record apunta a esa IPv4 y que
HTTPS responde en `/api/health`. Antes de marcarlo como aprobado, verifica
también que la réplica de Litestream exista y que se pueda restaurar fuera de la
base activa, como indica [LITESTREAM-SETUP.md](./LITESTREAM-SETUP.md).

## Ensayo del día-D

Hazlo varios días antes de la inscripción real. El ensayo mide el pool de
contexts y los pre-warms; **no debe llegar a ejecutar el click final de
inscripción**.

1. Invita solo a las personas que aceptaron participar del ensayo y que ya
   estén en la allowlist. Cada una inicia sesión y termina su primer sync en
   días previos; no se hacen primeros logins a las 5:50am.
2. Con consentimiento explícito de cada participante, programa un disparo de
   prueba a la misma hora futura y con un carrito ya validado. El sistema
   reparte los pre-warms establemente entre T−8 y T−5 minutos. Cancela todos
   los disparos antes de T0: navegar el asistente es la prueba; enviar la
   matrícula no lo es.
3. Durante la ventana, observa `docker stats` y `docker compose logs -f app`.
   Confirma que cada usuario informe “Disparo preparado”, que no haya crash de
   Chromium ni tres fallos consecutivos, y que la alerta ntfy llegue si se
   fuerza un fallo controlado fuera de la ventana de inscripción.
4. Revisa el audit log de cada cuenta, cancela los schedules de prueba y borra
   las credenciales persistidas que ya no necesiten funciones desatendidas.

Registra la evidencia fuera del repositorio (no incluye contraseñas, cookies ni
logs con datos académicos): fecha/hora, número de contexts, pico de CPU/RAM,
resultado de cada pre-warm, entrega del fallback del operador y decisión de
capacidad. Si el Droplet se acerca al límite, se aumenta su capacidad antes de
invitar más personas; no el día-D.

## Onboarding por invitación

Abre la beta solo después de que el gate y el ensayo estén aprobados. Agrega
usuarios a `MIKAMPUS_ALLOWLIST`, recrea la app y manda invitaciones una semana
antes de la inscripción. Cada invitado debe completar login, primer sync,
instalación de PWA/Web Push y, si activa watcher o disparo, el consentimiento de
credencial persistida. La invitación explica que esa credencial se cifra y se
borra al cerrar la ventana de inscripción o cuando la persona la desactive.

No se agregan personas nuevas durante la última hora antes del appointment.
Si falla DNS/TLS, Litestream, el ensayo de carga o el portal desde la IP del
Droplet, el lanzamiento hosted queda detenido y el modo local open source sigue
siendo el fallback.
