import fs from 'node:fs';
import path from 'node:path';
import { withTeamsPage } from './session.js';
import { SITES_HOST, recordingsInSite, sitesWithRecentRecordings } from './sites.js';

// De donde salen de verdad las transcripciones de clase.
//
// **La correccion que reordeno todo esto.** Elias no baja nada: tiene la
// transcripcion encendida y Teams la sube sola al terminar la llamada, asi que
// el archivo nunca pasa por su carpeta de descargas y un vigilante que mire el
// disco no ve una clase jamas.
//
// **Y una transcripcion no es un fichero.** Eso costo un rato de entender. En
// la carpeta compartida solo aparece la grabacion, un `.mp4`; no hay ningun
// `.vtt` al lado. La transcripcion cuelga del video, y se pide aparte. Son tres
// saltos, los tres comprobados contra la cuenta real el 21 de septiembre de 2026:
//
//   1. `/_api/v2.0/me/drive/sharedWithMe`  las grabaciones que el profesor
//      comparte, que son todas las clases. `recent` cubre las que organiza el.
//   2. `/_api/v2.1/drives/{drive}/items/{item}/media/transcripts`  que
//      transcripciones tiene ese video. Vacio significa que Teams todavia no la
//      genero, no que la clase no la tenga.
//   3. `.../transcripts/{id}/streamContent`  el WEBVTT entero.
//
// **Por que la API y no la interfaz.** Teams se repinta entero cada pocos meses
// y un selector escrito hoy se cae sin avisar. Esto responde JSON y acepta la
// misma cookie de sesion del navegador.
//
// Nada de esto escribe en Teams ni en SharePoint. Solo lista y descarga.

/** El host de OneDrive del tenant de la universidad. */
export const TENANT_HOST = 'cepucmmedu-my.sharepoint.com';

/** Donde se deja lo descargado. Es una de las carpetas que vigila `class-watch`. */
export function transcriptsDir(env = process.env) {
  return path.join(env.HOME ?? process.env.HOME ?? '', '.local/share/mikampus/teams');
}

/**
 * Cuantas horas atras se mira. Una clase de las diez de la manana sigue
 * contando a las once de la noche, y Teams puede tardar en publicar el video.
 */
export const RECENT_HOURS = 14;

const isRecording = (name) => /\.(mp4|mkv)$/i.test(name ?? '');

async function json(page, url) {
  const res = await page.request.get(url, { headers: { accept: 'application/json' } });
  if (!res.ok()) {
    const body = (await res.text().catch(() => '')).slice(0, 160);
    const err = new Error(`respondio ${res.status()}: ${body}`);
    err.status = res.status();
    throw err;
  }
  return res.json();
}

/**
 * SharePoint es otro host con su propia sesion.
 *
 * La cookie de `teams.microsoft.com` no vale aqui: sin esto la API responde 401
 * `unauthenticated`. Abrir la portada deja que el SSO de Microsoft emita las
 * cookies de este dominio antes de pedir nada.
 */
async function signIntoDrive(page, host) {
  await page.goto(`https://${host}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(4_000);
}

/** La referencia que hace falta para preguntar por las transcripciones de un video. */
function recordingOf(item) {
  const remote = item.remoteItem ?? item;
  return {
    name: item.name ?? remote.name ?? '',
    modified: Date.parse(item.lastModifiedDateTime ?? remote.lastModifiedDateTime ?? '') || null,
    driveId: remote.parentReference?.driveId ?? null,
    itemId: remote.id ?? null,
    host: TENANT_HOST,
    site: null,
  };
}

/** Las grabaciones de las ultimas horas, por las dos puertas, sin repetir. */
export async function recentRecordings(page, { host = TENANT_HOST, hours = RECENT_HOURS, now = Date.now() } = {}) {
  const desde = now - hours * 3600_000;
  const puertas = ['sharedWithMe', 'recent'];
  const vistas = new Map();
  const fallos = [];

  for (const puerta of puertas) {
    try {
      const payload = await json(page, `https://${host}/_api/v2.0/me/drive/${puerta}`);
      for (const item of payload?.value ?? []) {
        const rec = recordingOf(item);
        if (!isRecording(rec.name) || !rec.driveId || !rec.itemId) continue;
        if (rec.modified && rec.modified < desde) continue;
        // Una clase de canal aparece por las dos puertas: la llave es el item.
        vistas.set(rec.itemId, rec);
      }
    } catch (err) {
      fallos.push(`${puerta}: ${err.message}`);
    }
  }
  return { recordings: [...vistas.values()], fallos };
}

/**
 * Las transcripciones de una grabacion.
 *
 * Una lista vacia es el caso normal en los minutos siguientes a colgar: el
 * video ya subio y la transcripcion todavia se esta generando. Por eso el
 * llamador la reintenta en vez de darla por perdida.
 */
export async function transcriptsOf(page, rec, { host = rec.host ?? TENANT_HOST } = {}) {
  const payload = await json(page, `https://${host}/_api/v2.1/drives/${rec.driveId}/items/${rec.itemId}/media/transcripts`);
  return payload?.value ?? [];
}

/** El nombre del video sin el sufijo que Teams le cuelga, para que se lea. */
function tidyName(name) {
  return name
    .replace(/\.(mp4|mkv)$/i, '')
    .replace(/-(Grabaci[oó]n de la reuni[oó]n|Meeting Recording)$/i, '')
    .replace(/[^\w.\- ]+/g, '-')
    .replace(/[\s-]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Baja el WEBVTT al directorio que vigila `class-watch`.
 *
 * El nombre lleva la fecha delante porque el de Teams no dice de que clase es:
 * "Reunion en _General_" nombra dos materias distintas. La fecha es la de la
 * grabacion, que es cuando termino la llamada.
 */
export async function download(page, rec, transcript, { host = rec.host ?? TENANT_HOST, dir = transcriptsDir(), now = Date.now() } = {}) {
  const dia = new Date(rec.modified ?? now).toISOString().slice(0, 10);
  // Con la materia delante, porque "Meeting in General" nombra a las tres.
  const etiqueta = rec.site ? `${tidyName(rec.site)}-${tidyName(rec.name)}` : tidyName(rec.name);
  const destino = path.join(dir, `${dia}-${etiqueta}.vtt`);
  fs.mkdirSync(dir, { recursive: true });
  // Si ya esta, no se vuelve a bajar: el vigilante ya lo tiene en su libreta.
  if (fs.existsSync(destino)) return { path: destino, skipped: true };

  const url = transcript.temporaryDownloadUrl
    ?? `https://${host}/_api/v2.1/drives/${rec.driveId}/items/${rec.itemId}/media/transcripts/${transcript.id}/streamContent`;
  const res = await page.request.get(url);
  if (!res.ok()) throw new Error(`descarga fallida (${res.status()})`);
  const cuerpo = await res.text();
  if (!cuerpo.includes('WEBVTT')) throw new Error('lo que llego no es un WEBVTT');

  fs.writeFileSync(destino, cuerpo);
  return { path: destino, skipped: false, bytes: Buffer.byteLength(cuerpo) };
}

/**
 * Busca y baja lo que Teams haya publicado. Es lo que corre el timer.
 *
 * No lanza por un fallo de red ni por una sesion caducada: devuelve el motivo.
 * Un timer que muere no dice nada, y lo que hay que saber es si hace falta
 * volver a entrar a Teams.
 */
export async function sync({ hours = RECENT_HOURS, dir = transcriptsDir(), now = Date.now(), dryRun = false } = {}) {
  try {
    return await withTeamsPage(async (page) => {
      await signIntoDrive(page, TENANT_HOST);
      const { recordings, fallos } = await recentRecordings(page, { hours, now });

      // Las clases no estan en el OneDrive personal: son reuniones de canal y
      // su grabacion vive en el equipo de la materia. Sin esta puerta el
      // barrido encuentra reuniones sueltas y ninguna clase.
      try {
        await page.goto(`https://${SITES_HOST}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
        await page.waitForTimeout(4_000);
        for (const sitio of await sitesWithRecentRecordings(page, { hours, now })) {
          for (const rec of await recordingsInSite(page, sitio, { hours, now })) {
            if (!recordings.some((r) => r.itemId === rec.itemId)) recordings.push(rec);
          }
        }
      } catch (err) {
        fallos.push(`equipos: ${err.message}`);
      }
      const bajadas = [];
      const sinTranscripcion = [];

      for (const rec of recordings) {
        let lista;
        try {
          lista = await transcriptsOf(page, rec);
        } catch (err) {
          fallos.push(`${rec.name}: ${err.message}`);
          continue;
        }
        if (!lista.length) {
          sinTranscripcion.push(rec.name);
          continue;
        }
        if (dryRun) {
          bajadas.push({ name: rec.name, path: null, skipped: true, dryRun: true });
          continue;
        }
        try {
          bajadas.push({ name: rec.name, ...(await download(page, rec, lista[0], { dir, now })) });
        } catch (err) {
          fallos.push(`${rec.name}: ${err.message}`);
        }
      }
      return { recordings: recordings.map((r) => r.name), bajadas, sinTranscripcion, fallos, dryRun };
    });
  } catch (err) {
    if (err.needsTeamsLogin) return { recordings: [], bajadas: [], sinTranscripcion: [], fallos: [], needsLogin: true };
    return { recordings: [], bajadas: [], sinTranscripcion: [], fallos: [err.message] };
  }
}
