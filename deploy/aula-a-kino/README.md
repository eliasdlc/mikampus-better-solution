# El barrido del aula, cada seis horas

`mikampus aula-a-kino` sincroniza las fuentes de la PVA y sube a Kino lo que la
plataforma publicó y todavía no era una tarea. Corre sin nadie delante, así que
lo dispara un timer de systemd y no un temporizador dentro del agente: un timer
sobrevive a que el agente esté parado, y `Persistent=true` recupera el disparo
que se perdió mientras la máquina estaba apagada.

Nace apagado. Sin `KINO_ACADEMICO_URL` y `KINO_ACADEMICO_TOKEN` el comando
imprime que está apagado y sale con 0.

## Las dos máquinas

El barrido corre en el laptop y, cuando el laptop está apagado, en agentbox.
**No se coordinan con un candado**, y eso es deliberado: dos máquinas que se
reparten trabajo con un candado se bloquean justo cuando una se apaga, que es el
caso para el que existe la segunda.

Lo que las hace compatibles es la idempotencia del otro lado. Kino guarda cada
item bajo `(userId, 'pva', externalId)`, así que el mismo aviso subido por las
dos máquinas es una sola tarea. Cada máquina lleva su propia base y su propio
libro `kino_at`; duplicar la subida cuesta una petición, nunca una tarea doble.

Lo único que evita agentbox es el trabajo inútil: antes de barrer pregunta por
Tailscale si el laptop está vivo, y si contesta, no hace nada. Si no contesta,
barre. Esa comprobación está en el `ExecCondition` de su unidad.

## Variables

| Variable | Qué es |
|---|---|
| `KINO_ACADEMICO_URL` | la ruta de ingesta del deployment de Convex, `https://<deployment>.convex.site/academico` |
| `KINO_ACADEMICO_TOKEN` | el mismo secreto que `npx convex env set KINO_ACADEMICO_TOKEN` en ese deployment |

Van en un fichero de entorno que solo lee tu usuario, nunca en la unidad:

```bash
install -m 600 /dev/null ~/.config/mikampus/aula-a-kino.env
cat > ~/.config/mikampus/aula-a-kino.env <<'EOF'
KINO_ACADEMICO_URL=https://<deployment>.convex.site/academico
KINO_ACADEMICO_TOKEN=<el secreto>
EOF
```

## Instalación en el laptop

```bash
mkdir -p ~/.config/systemd/user
cp deploy/aula-a-kino/aula-a-kino.service ~/.config/systemd/user/
cp deploy/aula-a-kino/aula-a-kino.timer   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now aula-a-kino.timer
```

Antes de encenderlo, mira lo que subiría sin subir nada:

```bash
node bin/mikampus.mjs aula-a-kino --dry-run
```

Y después, que el disparo existe y cuándo cae el próximo:

```bash
systemctl --user list-timers aula-a-kino.timer
journalctl --user -u aula-a-kino.service -n 20
```

## Instalación en agentbox

Lo mismo, con `aula-a-kino-respaldo.timer` en lugar del otro. Esa unidad añade
una condición: si el laptop responde por Tailscale, la ejecución se salta y
queda anotada en el journal como condición no cumplida, que es lo que se espera
ver la mayor parte del tiempo.

Cambia `decruces-omarchy` por el nombre real del laptop en la red si alguna vez
cambia.
