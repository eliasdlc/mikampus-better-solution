import { redact } from '../diagnostics.js';

// La última barrera antes de serializar una respuesta.
//
// La allowlist de src/mcp/allowlist.js ya decide qué se puede leer de la base;
// esto cubre el otro lado: un objeto armado a mano que por descuido arrastre una
// clave sensible, y el texto libre que viene del portal (sync_log.detail,
// action_log.portal_response), donde puede haber una matrícula o un token de
// estado de PeopleSoft metido en un mensaje de error.

const FORBIDDEN_KEYS = [
  'password',
  'passwd',
  'token',
  'csrf',
  'cookie',
  'hash',
  'ciphertext',
  'iv',
  'tag',
  'p256dh',
  'auth',
  'endpoint',
  'secret',
  'credential',
  'portalusername',
  'username',
  'emplid',
];

// La comparación es por TOKEN y no por substring: "active" contiene "iv" y
// "authorized" contiene "auth", y una denylist que corta por substring termina
// borrando campos legítimos sin que nadie se entere.
function tokensOf(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

function keyIsForbidden(key) {
  const tokens = tokensOf(key);
  return tokens.some((token) => FORBIDDEN_KEYS.includes(token));
}

// Recorre la respuesta entera: elimina cualquier clave prohibida a cualquier
// profundidad y pasa todo string por la redacción de diagnósticos.
export function sanitize(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (keyIsForbidden(key)) continue;
      out[key] = sanitize(entry);
    }
    return out;
  }
  return value;
}

export { FORBIDDEN_KEYS };
