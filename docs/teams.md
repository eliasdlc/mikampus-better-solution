# La transcripcion de una clase, desde Teams

Tres de los cuatro profesores de Elias activan la transcripcion de Teams: los
VTT que baja a mano traen `<v NOMBRE>` de Beato, Pena y Dorville, entre 1.173 y
1.712 intervenciones cada uno. El cuarto, Alonso, no graba sus clases, y eso no
lo arregla ningun automatismo.

El destino de esos archivos es `agents class-watch`, el vigilante del
repositorio de agentes: mira `~/Downloads` y `~/.local/share/mikampus/teams`
cada diez minutos, y le pasa cada transcripcion nueva a un agente que la
convierte en notas y tareas. Lo que falta aqui es llenar el segundo directorio
sin que Elias tenga que bajar nada.

## Por que no se usa Microsoft Graph

Dos puertas independientes, y las dos las abre el administrador de
`pucmm.edu.do`, no un estudiante:

| Puerta | Que pasa hoy |
|---|---|
| El permiso delegado sobre transcripciones atiende al **organizador** de la reunion | Los profesores organizan; Elias es participante |
| El acceso de Graph a transcripciones nace **apagado** en todo tenant | Nadie lo ha encendido, y pedirlo es un ticket sin fecha |

Asi que la via es la interfaz, con la sesion de Elias, que es el mismo patron
con el que este proyecto lee MiCampus y la PVA.

## La sesion

```bash
mikampus teams-login     # abre una ventana, una vez
mikampus teams-status    # dice si hay estado guardado y de cuando
```

`teams-login` es **el unico momento en que este proyecto abre una ventana**.
Todo lo demas corre headless porque nada puede tomarle la pantalla; una
pantalla de MFA institucional no se resuelve de otra forma.

No hay credencial guardada, y no es un olvido. El portal acepta usuario y
contrasena, asi que puede reautenticar solo; Teams pide un segundo factor, que
no se guarda en un fichero. Lo que se guarda es el resultado del login, el
`storageState` de Playwright, en `teams-state.json` con modo 600. Cuando esas
cookies caducan no hay nada que reintentar en silencio: hace falta el otra vez.

Por eso `withTeamsPage` falla con `needsTeamsLogin` en vez de abrir una ventana
por su cuenta. Un cron que abre un navegador en mitad de una clase es peor que
un cron que no corre.

## Lo que falta, y por que no esta escrito todavia

La descarga. Y no esta escrita porque escribirla sin mirar seria inventar
selectores: `CONTRIBUTING.md` pide recon antes de tocar un scraper, y el recon
necesita la sesion, que necesita las manos de Elias.

```bash
mikampus teams-login
npm run recon:teams
```

`recon:teams` vuelca en el directorio de datos **la forma** de cada pantalla:
que `data-tid` existen, cuantos hay, que rol tienen y cuanto mide su texto.
Nunca el texto: al otro lado hay nombres de companeros y de profesores. El
volcado no entra al repositorio; de ahi se derivan a mano los selectores de la
lista de reuniones y del boton de descarga, y se escriben en `src/teams/`.

Mientras tanto el sistema funciona entero con lo que Elias baja a mano: el
vigilante recoge el `.vtt` de `~/Downloads` igual, y lo unico que cambia el dia
que esta pieza exista es quien pone el archivo ahi.
