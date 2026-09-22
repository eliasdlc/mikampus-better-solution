import fs from 'node:fs';
import path from 'node:path';
import { dataPaths } from '../paths.js';
import { withTeamsPage } from './session.js';

// De donde salen de verdad las transcripciones de clase.
//
// **La correccion que reordeno todo esto.** Elias no baja nada: Teams tiene la
// transcripcion encendida y la sube sola al terminar la llamada. Asi que el
// archivo nunca pasa por su carpeta de descargas, y un vigilante que mire el
// disco no ve nada nunca. Lo que hay que mirar es el sitio donde Teams la deja,
// que es OneDrive del tenant de la universidad.
//
// **Por que la API y no el DOM.** La interfaz de Teams es una aplicacion que se
// repinta entera cada pocos meses; un selector escrito hoy se cae sin avisar. La
// API de OneDrive sobre SharePoint responde JSON, esta documentada, y acepta la
// misma cookie de sesion que el navegador. `_api/v2.0/me/drive/recent` y
// `sharedWithMe` son las dos puertas: la primera para las reuniones que
// organizas, la segunda para las que organiza el profesor y comparte contigo,
// que son todas las clases.
//
// Nada de esto escribe en Teams ni en SharePoint. Solo lista y descarga.

/** El host de OneDrive del tenant. Sale de las cookies, nunca se escribe a mano. */
export const TENANT_HOST = 'cepucmmedu-my.sharepoint.com';

/** Donde se deja lo descargado. Es una de las carpetas que vigila `class-watch`. */
export function transcriptsDir(env = process.env) {
  return path.join(env.HOME ?? process.env.HOME ?? '', '.local/share/mikampus/teams');
}

/** Cuantas horas atras se considera "de hoy". Una clase de la manana sigue contando de noche. */
export const RECENT_HOURS = 14;

const isTranscript = (name) => /\.(vtt|docx)$/i.test(name ?? '');

/**
 * Una llamada a la API de OneDrive con la sesion del navegador.
 *
 * `page.request` reusa las cookies del contexto, asi que esto va autenticado sin
 * tocar un token: es la misma credencial que el navegador, con el mismo alcance
 * y la misma caducidad.
 */
async function api(page, url) {
  const res = await page.request.get(url, { headers: { accept: 'application/json' } });
  if (!res.ok()) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    const err = new Error(`OneDrive respondio ${res.status()}: ${body}`);
    err.status = res.status();
    throw err;
  }
  return res.json();
}

/** Aplana lo que devuelven `recent` y `sharedWithMe` a una forma sola. */
function itemsOf(payload) {
  return (payload?.value ?? []).map((item) => ({
    id: item.id ?? null,
    name: item.name ?? '',
    modified: Date.parse(item.lastModifiedDateTime ?? item.fileSystemInfo?.lastModifiedDateTime ?? '') || null,
    size: item.size ?? null,
    // El id del drive viaja en sitios distintos segun la puerta por la que entro.
    driveId: item.parentReference?.driveId ?? item.remoteItem?.parentReference?.driveId ?? null,
    remoteId: item.remoteItem?.id ?? null,
    downloadUrl: item['@content.downloadUrl'] ?? item['@microsoft.graph.downloadUrl'] ?? null,
  }));
}

/**
 * Las transcripciones que Teams dejo en las ultimas horas.
 *
 * Las dos puertas se consultan siempre y sus resultados se juntan por nombre y
 * tamano: una clase de canal puede aparecer en las dos, y descargarla dos veces
 * seria dos corridas de agente sobre la misma clase.
 */
export async function recentTranscripts(page, { host = TENANT_HOST, hours = RECENT_HOURS, now = Date.now() } = {}) {
  const desde = now - hours * 3600_000;
  const puertas = [
    `https://${host}/_api/v2.0/me/drive/recent`,
    `https://${host}/_api/v2.0/me/drive/sharedWithMe`,
  ];

  const vistos = new Map();
  const fallos = [];
  for (const puerta of puertas) {
    try {
      for (const item of itemsOf(await api(page, puerta))) {
        if (!isTranscript(item.name)) continue;
        if (item.modified && item.modified < desde) continue;
        vistos.set(`${item.name}:${item.size ?? 0}`, item);
      }
    } catch (err) {
      fallos.push(`${puerta.split('/_api')[1]}: ${err.message}`);
    }
  }
  return { items: [...vistos.values()], fallos };
}

/**
 * Baja una transcripcion al directorio que vigila `class-watch`.
 *
 * El nombre en disco lleva la fecha por delante porque el de Teams no dice de
 * que clase es: "Reunion en _General_ .vtt" nombra dos materias distintas. La
 * fecha es la de modificacion del archivo, que es cuando termino la llamada.
 */
export async function download(page, item, { dir = transcriptsDir(), now = Date.now() } = {}) {
  const url = item.downloadUrl
    ?? `https://${TENANT_HOST}/_api/v2.0/drives/${item.driveId}/items/${item.remoteId ?? item.id}/content`;
  const res = await page.request.get(url);
  if (!res.ok()) throw new Error(`descarga fallida (${res.status()}) de ${item.name}`);

  const dia = new Date(item.modified ?? now).toISOString().slice(0, 10);
  const limpio = item.name.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-');
  const destino = path.join(dir, `${dia}-${limpio}`);
  fs.mkdirSync(dir, { recursive: true });
  // Si ya esta, no se vuelve a bajar: el vigilante ya lo tiene en su libreta.
  if (fs.existsSync(destino)) return { path: destino, skipped: true };
  fs.writeFileSync(destino, await res.body());
  return { path: destino, skipped: false, bytes: fs.statSync(destino).size };
}

/**
 * Busca y baja lo que Teams haya dejado. Es lo que corre el timer.
 *
 * No lanza por un fallo de red ni por una sesion caducada: devuelve el motivo.
 * Un timer que muere no dice nada, y lo que hay que saber es si hace falta
 * volver a entrar a Teams.
 */
export async function sync({ hours = RECENT_HOURS, dir = transcriptsDir(), now = Date.now(), dryRun = false } = {}) {
  try {
    return await withTeamsPage(async (page) => {
      const { items, fallos } = await recentTranscripts(page, { hours, now });
      if (dryRun) return { items: items.map((i) => i.name), bajadas: [], fallos, dryRun: true };
      const bajadas = [];
      for (const item of items) {
        try {
          bajadas.push({ name: item.name, ...(await download(page, item, { dir, now })) });
        } catch (err) {
          fallos.push(`${item.name}: ${err.message}`);
        }
      }
      return { items: items.map((i) => i.name), bajadas, fallos };
    });
  } catch (err) {
    if (err.needsTeamsLogin) return { items: [], bajadas: [], fallos: [], needsLogin: true };
    return { items: [], bajadas: [], fallos: [err.message] };
  }
}
