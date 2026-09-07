import crypto from 'node:crypto';

// Normalizaciones de las respuestas de la PVA. Existen porque Moodle mezcla
// convenciones dentro de un mismo objeto y cada mezcla ya costó un hallazgo en
// el recon (MAPA-PVA.md §"Convenciones de tipos que hay que asumir"):
//
//   * El 0 de una fecha NO es 1970: es "no hay fecha".
//   * Booleanos JSON y 0/1 conviven en el mismo objeto, campo por campo.
//   * Hay tri-estados que llegan null y nunca false.
//   * Hay JSON adentro de un string, y a veces ese string es el literal "".
//   * Hay PHP serializado adentro de ese JSON.
//
// Todo esto se aplica al escribir, no al leer: la base guarda el valor ya
// interpretado y el crudo solo donde interpretarlo sería inventar.

/**
 * Epoch de Moodle a epoch o NULL. El centinela `0` significa "no hay fecha" en
 * duedate, cutoffdate, allowsubmissionsfromdate, gradingduedate, timecompleted
 * y extensionduedate. Formatearlo da 31 dic 1969 en la zona de Santo Domingo.
 */
export function epoch(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/**
 * Entero, o el valor por defecto si no hay número.
 *
 * `null` y la cadena vacía son ausencia, no cero: `Number(null)` es 0 y es
 * finito, así que sin esta guarda un `categoryid: null` se guardaría como 0 y
 * el total del curso parecería colgar de la categoría 0. Moodle manda `null`
 * explícito en un montón de campos (categoryid, groupid, repeatid, eventcount,
 * gradedategraded, timeread) y esa diferencia es dato.
 */
export function int(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** Número real, o null. Para notas, que pueden ser fraccionarias. */
export function real(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Booleano a 0/1 para SQLite. Acepta las dos formas que manda el servidor
 * (`true` y `1`) porque no hay regla: hay que ir campo por campo.
 */
export function bool01(value, fallback = 0) {
  if (value === true || value === 1 || value === '1') return 1;
  if (value === false || value === 0 || value === '0') return 0;
  return fallback;
}

/**
 * Tri-estado. `locked`, `gradeislocked` y `gradeisoverridden` llegan `null` y
 * nunca `false`: null y 0 significan cosas distintas y colapsarlos pierde el
 * "el servidor no lo dijo".
 */
export function triState(value) {
  if (value === null || value === undefined) return null;
  return bool01(value);
}

/** Texto, con vacío por defecto. `null` y `''` son estados distintos arriba. */
export function text(value, fallback = '') {
  return value === null || value === undefined ? fallback : String(value);
}

/** Texto que conserva la diferencia entre ausente (null) y vacío (''). */
export function textOrNull(value) {
  return value === null || value === undefined ? null : String(value);
}

/**
 * `customdata` es un string con JSON adentro, y a veces ese string es el
 * literal `""`, que es truthy. La guarda correcta es parsear y comprobar que
 * dio un objeto; `if (customdata)` deja pasar la cadena vacía.
 *
 * Adentro los tipos no son consistentes (`duedate` number y
 * `allowsubmissionsfromdate` string en el mismo objeto), así que quien lo use
 * pasa cada campo por `epoch`.
 */
export function parseCustomData(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * El cmid que viaja en el `?id=` de una URL de módulo. Es cómo se resuelve el
 * curso de una notificación, que no dice a qué curso pertenece.
 */
export function cmidFromUrl(url) {
  if (typeof url !== 'string') return null;
  const match = /[?&]id=(\d+)/.exec(url);
  return match ? Number(match[1]) : null;
}

/**
 * Serialización estable para hashear: las claves van ordenadas, así que dos
 * respuestas con el mismo contenido en distinto orden dan el mismo hash y el
 * delta local no ve un cambio donde no lo hay.
 */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function hashOf(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

/** Segundos, que es la unidad de todo epoch de Moodle. Nunca milisegundos. */
export function nowSeconds(now = Date.now()) {
  return Math.floor(now / 1000);
}
