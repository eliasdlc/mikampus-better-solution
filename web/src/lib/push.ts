import { fetchVapidKey, subscribePush, unsubscribePush } from './api.ts';

// El lado del navegador de Web Push (§5.5). La suscripción vive en el service
// worker; acá se la pide al navegador, se la registra en el server y se puede
// revocar. Dos verdades incómodas que la UI absorbe (§5.5): en iOS solo existe
// con la PWA instalada al home screen, y el permiso lo tiene que dar el usuario
// con un gesto — no se puede pedir a ciegas al cargar.

export type PushState = {
  supported: boolean;
  permission: NotificationPermission; // 'default' | 'granted' | 'denied'
  subscribed: boolean;
};

// El push necesita las tres piezas: service worker (shell), PushManager (envío)
// y Notification (mostrar). En dev sin HTTPS o en un navegador viejo falta
// alguna, y la UI dice "no disponible acá" en vez de romper.
export function pushSupported(): boolean {
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window &&
    window.isSecureContext
  );
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) {
    return { supported: false, permission: 'denied', subscribed: false };
  }
  const sub = await currentSubscription();
  return { supported: true, permission: Notification.permission, subscribed: sub != null };
}

// El applicationServerKey va como Uint8Array, no como el base64url que expone el
// server: esta es la conversión estándar (padding + url-safe → binario).
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Pide permiso, se suscribe y registra en el server. Lanza con un mensaje
// legible si el usuario negó el permiso o el server no tiene VAPID configurado:
// la UI lo muestra tal cual, sin traducir un error críptico del navegador.
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) throw new Error('Este dispositivo no soporta notificaciones push.');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Necesito permiso de notificaciones para avisarte cuando abra un cupo.');
  }

  const key = await fetchVapidKey();
  if (!key) throw new Error('El servidor no tiene las notificaciones push configuradas todavía.');

  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    }));

  await subscribePush(sub.toJSON());
  return { supported: true, permission: 'granted', subscribed: true };
}

// Revoca en este dispositivo: borra la suscripción local y le avisa al server
// para que deje de intentar mandarle. Los otros dispositivos del usuario siguen.
export async function disablePush(): Promise<PushState> {
  const sub = await currentSubscription();
  if (sub) {
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => {});
    await unsubscribePush(endpoint).catch(() => {});
  }
  return { supported: pushSupported(), permission: Notification.permission, subscribed: false };
}
