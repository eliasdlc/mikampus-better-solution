import { spawn } from 'node:child_process';
import { dispatchPush } from './webpush.js';
import { recordNotification, shouldSend } from './notifications.js';
import { dispatchToChannels } from './channels.js';

// Notificaciones unificadas (plan §7, Fase 5). Antes cada operación decidía por
// su cuenta si molestar al usuario: el enroll llamaba a notify() desde tres
// puntos del scheduler y todo lo demás (un sync que falla, un watcher que dejó
// de ver el portal) se quedaba en el feed, que nadie mira si no está en la app.
//
// Ahora hay UN camino: el backend emite eventos y esta política decide cuáles
// merecen una notificación de escritorio y con qué urgencia. Un solo lugar que
// leer para saber qué te va a interrumpir.

const OPENERS = {
  win32: (url) => ['cmd', ['/c', 'start', '', url]],
  darwin: (url) => ['open', [url]],
  linux: (url) => ['xdg-open', [url]],
};

function baseUrl() {
  return `http://127.0.0.1:${process.env.PORT || 4173}`;
}

export function deepLink(link) {
  if (!link) return null;
  return link.startsWith('http') ? link : `${baseUrl()}${link}`;
}

function openLink(url) {
  const opener = (OPENERS[process.platform] ?? OPENERS.linux)(url);
  spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).on('error', () => {});
}

// notify-send ya está disponible en el entorno Hyprland/mako del usuario:
// notificación de escritorio inmediata, sin depender de un bot externo.
//
// El deep-link es donde las plataformas dejan de ser iguales: en Linux la
// notificación lleva un botón real que abre la pantalla correcta (notify-send
// --wait devuelve la acción elegida). macOS con osascript y el toast de
// PowerShell no exponen un click accionable sin empaquetar una app firmada, así
// que ahí el enlace viaja en el cuerpo. No se promete lo que el OS no da.
export function notify(title, body, { urgency = 'normal', link = null } = {}) {
  // Sin escritorio no hay popup que valga: los tests corren
  // con MIKAMPUS_SILENT=1 y la política sigue siendo verificable en seco.
  if (process.env.MIKAMPUS_SILENT) return;
  // Home Server no intenta convertir su host en un proveedor push: el feed SSE
  // local es el transporte base. Desktop elige el adaptador nativo disponible.
  if (process.env.MIKAMPUS_RUNTIME_MODE === 'home-server') return;
  const url = deepLink(link);
  const linuxAction = process.platform === 'linux' && url;
  const withLink = url && !linuxAction ? `${body}\n${url}` : body;

  const command = process.platform === 'darwin'
    ? ['osascript', ['-e', `display notification ${JSON.stringify(withLink)} with title ${JSON.stringify(title)}`]]
    : process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-Command', `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('mikampus').Show([Windows.UI.Notifications.ToastNotification]::new(([Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier()).GetTemplateContent(0)))`]]
      : ['notify-send', linuxAction
        ? ['-u', urgency, '-a', 'mikampus', '--wait', '-A', 'default=Abrir mikampus', title, body]
        : ['-u', urgency, '-a', 'mikampus', title, withLink]];

  const child = spawn(command[0], command[1], {
    stdio: linuxAction ? ['ignore', 'pipe', 'ignore'] : 'ignore',
  });
  // `notify-send --wait` no vuelve hasta que la notificación se cierra, y una
  // urgencia `critical` en mako no se cierra sola. Sin unref, ese hijo
  // mantendría vivo el event loop del agente indefinidamente.
  child.unref();
  // notify-send --wait imprime la acción elegida cuando el usuario hace click.
  child.stdout?.on('data', (chunk) => {
    if (String(chunk).trim() === 'default') openLink(url);
  });
  child.on('error', () => {
    console.warn('[notify] transporte de notificación nativo no disponible, el evento sigue en el feed local');
  });
}

// La política, pura y sin efectos para poder verificarla sin popups
// (scripts/test-notify.mjs). Devuelve la notificación que corresponde, o null si
// el evento no merece interrumpir.
//
// La regla: se notifica lo que cambia el mundo (te inscribiste, apareció un
// cupo) y lo que exige acción (algo falló y hay que meter mano). El resto —
// progreso, pasos de un scraper, estado del watcher— vive en el feed. Una app
// que notifica todo se silencia entera, y ese día se pierde la única
// notificación que importaba.
export function noticeFor(event) {
  if (event.type === 'notice') {
    const urgency = event.level === 'error' ? 'critical' : 'normal';
    // key agrupa lo repetible para el dedupe: sin ella, un watcher que falla
    // cada 45s son 80 popups por hora del mismo error.
    return {
      title: event.title,
      body: event.body ?? '',
      urgency,
      key: event.key ?? `notice:${event.title}`,
      // Una notificación sin destino obliga a buscar a mano qué la causó. El
      // deep-link lleva a la pantalla donde se resuelve ese aviso.
      link: event.link ?? '/ajustes',
    };
  }

  if (event.type === 'enroll-result') {
    const ok = event.results.filter((r) => r.success);
    const fail = event.results.filter((r) => !r.success);
    if (ok.length > 0) {
      return {
        title: '¡Inscrito!',
        body: ok.map((r) => r.classLabel).join(', '),
        // critical no es alarmismo: en Hyprland/mako es la que no se auto-cierra
        // sola. Es LA notificación por la que existe esta app y no puede
        // desaparecer mientras estás en otra ventana.
        urgency: 'critical',
        key: `enroll-ok:${ok.map((r) => r.classLabel).join('|')}`,
        link: '/horario',
      };
    }
    // Un intento sin cupo no es noticia: es lo esperado y el watcher reintenta
    // en 45s. Salvo que el watcher HAYA visto cupo y aun así no entráramos —
    // eso significa que alguien fue más rápido, y es lo que querés saber para
    // decidir a mano.
    if (fail.length > 0 && event.reason === 'cupo detectado') {
      return {
        title: 'Apareció cupo pero no entraste',
        body: fail.map((r) => `${r.classLabel}: ${r.message}`).join('\n'),
        urgency: 'critical',
        key: `enroll-lost:${fail.map((r) => r.classLabel).join('|')}`,
        link: '/inscripcion',
      };
    }
  }

  return null;
}

export function notifyFromEvent(event, now = Date.now()) {
  const notice = noticeFor(event);
  if (!notice) return null;

  // Web Push (§5.5): un evento con dueño también va al teléfono de
  // ESE usuario. Va antes del dedupe de escritorio y con su propio dedupe por
  // usuario (webpush.js) — el popup local es de una sola persona; la push es
  // por dueño y no puede quedar silenciada porque el server local no tenga
  // escritorio. Fire-and-forget: un push service lento no frena esta política.
  if (event.userId != null) {
    dispatchPush(event.userId, notice, event, now);
  }

  // El dedupe consulta la base y no un Map del proceso: reiniciar el agente ya
  // no vuelve a disparar la misma alerta que se acababa de mostrar.
  if (!shouldSend(notice.key, now)) return null;
  recordNotification(notice, { userId: event.userId ?? null, now: new Date(now) });

  notify(notice.title, notice.body, { urgency: notice.urgency, link: notice.link });
  // Los adaptadores externos son opt-in y viven apagados; si el usuario
  // encendió alguno, recibe el mismo payload mínimo declarado.
  dispatchToChannels(notice).catch((error) => console.warn(`[notify] adaptador externo falló: ${error.message}`));
  return notice;
}
