const DEFAULT_ATTEMPTS = 5;
const DEFAULT_JITTER_SECONDS = 90;

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} debe ser un entero mayor que cero`);
  }
  return parsed;
}

export function probeConfig(env = process.env) {
  return {
    attempts: positiveInteger(env.PHASE0_LOGIN_ATTEMPTS, DEFAULT_ATTEMPTS, 'PHASE0_LOGIN_ATTEMPTS'),
    jitterSeconds: positiveInteger(env.PHASE0_JITTER_SECONDS, DEFAULT_JITTER_SECONDS, 'PHASE0_JITTER_SECONDS'),
    live: env.PHASE0_CONFIRM_LIVE === 'true',
  };
}

export function jitterDelayMs(jitterSeconds, random = Math.random) {
  return Math.floor(random() * jitterSeconds * 1000);
}
