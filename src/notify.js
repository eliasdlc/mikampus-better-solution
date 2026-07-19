import { spawn } from 'node:child_process';

// Notificaciones unificadas (plan §7, Fase 5). Antes cada operación decidía por
// su cuenta si molestar al usuario: el enroll llamaba a notify() desde tres
// puntos del scheduler y todo lo demás (un sync que falla, un watcher que dejó
// de ver el portal) se quedaba en el feed, que nadie mira si no está en la app.
//
// Ahora hay UN camino: el backend emite eventos y esta política decide cuáles
// merecen una notificación de escritorio y con qué urgencia. Un solo lugar que
// leer para saber qué te va a interrumpir.

// notify-send ya está disponible en el entorno Hyprland/mako del usuario:
// notificación de escritorio inmediata, sin depender de un bot externo.
export function notify(title, body, { urgency = 'normal' } = {}) {
  // Sin escritorio no hay popup que valga: el server hosted y los tests corren
  // con MIKAMPUS_SILENT=1 y la política sigue siendo verificable en seco.
  if (process.env.MIKAMPUS_SILENT) return;
  const child = spawn('notify-send', ['-u', urgency, '-a', 'mikampus', title, body], {
    stdio: 'ignore',
  });
  child.on('error', () => {
    console.warn('[notify] notify-send no disponible, se omite notificación de escritorio');
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
    return { title: event.title, body: event.body ?? '', urgency, key: event.key ?? `notice:${event.title}` };
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
      };
    }
  }

  return null;
}

// Misma notificación repetida dentro de esta ventana → se manda una sola vez.
const DEDUPE_MS = 5 * 60 * 1000;
const lastSent = new Map();

export function notifyFromEvent(event, now = Date.now()) {
  const notice = noticeFor(event);
  if (!notice) return null;

  const previo = lastSent.get(notice.key);
  if (previo != null && now - previo < DEDUPE_MS) return null;
  lastSent.set(notice.key, now);

  notify(notice.title, notice.body, { urgency: notice.urgency });
  return notice;
}
