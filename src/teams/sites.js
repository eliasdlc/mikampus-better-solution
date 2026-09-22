// Las grabaciones que viven en el equipo de una materia, no en tu OneDrive.
//
// **El fallo que este modulo corrige.** La primera version buscaba solo en
// `me/drive`, el OneDrive personal, porque la unica grabacion que aparecia el
// dia que se escribio estaba ahi. Era una reunion privada con un profesor, y de
// ese caso se generalizo mal.
//
// Una clase no es eso. Una clase es una **reunion de canal**: el profesor la
// abre desde el equipo de la materia, y Teams deja su grabacion en el
// SharePoint de ese equipo, en `General/Recordings`. Medido el 21 de septiembre
// de 2026 sobre la cuenta real: de 22 grabaciones visibles en `sharedWithMe`
// solo una era de este cuatrimestre, mientras el sitio de ICC-451 tenia cuatro
// clases de septiembre que nadie estaba mirando.
//
// **Como se encuentran.** La busqueda de SharePoint indexa lo que el estudiante
// puede ver, incluidos los equipos de sus materias, y `FileType:mp4` ordenado
// por fecha da los sitios con grabacion reciente sin tener que saber de antemano
// cuales son. Devuelve la pagina del elemento y no el fichero, asi que sirve
// para descubrir el sitio; los ficheros se listan despues por el drive del
// sitio, que si trae el `driveId` y el `id` que necesita `/media/transcripts`.
//
// `FileExtension:mp4` devuelve cero en este tenant. La propiedad que responde es
// `FileType`, y esto se comprobo antes de escribirlo.

/** El host de los sitios de equipo. El de OneDrive personal lleva `-my`. */
export const SITES_HOST = 'cepucmmedu.sharepoint.com';

/** Cuantos sitios se miran por barrido. Son las materias del cuatrimestre, no mas. */
export const MAX_SITES = 8;

async function json(page, url) {
  const res = await page.request.get(url, { headers: { accept: 'application/json' } });
  if (!res.ok()) {
    const err = new Error(`respondio ${res.status()}`);
    err.status = res.status();
    throw err;
  }
  return res.json();
}

/** Las celdas de un resultado de busqueda, como objeto. */
function cellsOf(row) {
  return Object.fromEntries((row?.Cells ?? []).map((cell) => [cell.Key, cell.Value]));
}

/**
 * Los sitios de equipo con una grabacion de las ultimas horas.
 *
 * Se piden mas filas de las que hacen falta porque el indice mezcla los equipos
 * de sus materias con los de cualquier otra cosa a la que pertenezca, y el
 * filtro por fecha se aplica aqui y no en la consulta: el operador de rango de
 * la busqueda se comporta distinto segun el tenant, y una fecha mal interpretada
 * devolveria cero en silencio.
 */
export async function sitesWithRecentRecordings(page, { host = SITES_HOST, hours = 14, now = Date.now(), rows = 25 } = {}) {
  const desde = now - hours * 3600_000;
  const url = `https://${host}/_api/search/query`
    + `?querytext=${encodeURIComponent("'FileType:mp4'")}`
    + `&rowlimit=${rows}`
    + `&selectproperties=${encodeURIComponent("'Title,LastModifiedTime,SiteTitle,SPWebUrl'")}`
    + `&sortlist=${encodeURIComponent("'LastModifiedTime:descending'")}`;

  const payload = await json(page, url);
  const filas = payload?.PrimaryQueryResult?.RelevantResults?.Table?.Rows ?? [];
  const sitios = new Map();
  for (const fila of filas) {
    const c = cellsOf(fila);
    const cuando = Date.parse(c.LastModifiedTime ?? '') || null;
    if (!c.SPWebUrl || !cuando || cuando < desde) continue;
    // Un sitio entra una vez, con su grabacion mas reciente.
    if (!sitios.has(c.SPWebUrl)) sitios.set(c.SPWebUrl, { web: c.SPWebUrl, title: c.SiteTitle ?? '', modified: cuando });
  }
  return [...sitios.values()].slice(0, MAX_SITES);
}

/**
 * Las grabaciones dentro de un sitio de equipo.
 *
 * Los canales son carpetas en la raiz de la biblioteca y cada uno tiene su
 * `Recordings`, asi que se recorren los canales en vez de dar por hecho que la
 * clase esta en `General`. Un canal sin grabaciones responde 404 y se salta:
 * es el caso normal, no un error.
 */
export async function recordingsInSite(page, site, { host = SITES_HOST, hours = 14, now = Date.now() } = {}) {
  const desde = now - hours * 3600_000;
  let canales;
  try {
    canales = (await json(page, `${site.web}/_api/v2.0/drive/root/children`)).value ?? [];
  } catch {
    return [];
  }

  const encontradas = [];
  for (const canal of canales) {
    if (!canal.folder || !canal.name) continue;
    let hijos;
    try {
      hijos = (await json(page, `${site.web}/_api/v2.0/drive/root:${encodeURI(`/${canal.name}/Recordings`)}:/children`)).value ?? [];
    } catch {
      continue;
    }
    for (const item of hijos) {
      if (!/\.(mp4|mkv)$/i.test(item.name ?? '')) continue;
      const cuando = Date.parse(item.lastModifiedDateTime ?? '') || null;
      if (cuando && cuando < desde) continue;
      if (!item.parentReference?.driveId || !item.id) continue;
      encontradas.push({
        name: item.name,
        modified: cuando,
        driveId: item.parentReference.driveId,
        itemId: item.id,
        // El host manda en los dos saltos siguientes, y no es el mismo que el
        // del OneDrive personal.
        host,
        site: site.title,
      });
    }
  }
  return encontradas;
}

