import 'dotenv/config';
import { loginToPeopleSoft } from '../src/login.js';
import { jitterDelayMs, probeConfig } from '../src/phase0.js';

const config = probeConfig();

async function publicIp() {
  const response = await fetch('https://api.ipify.org?format=json', {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`No se pudo leer la IP pública (${response.status})`);
  const payload = await response.json();
  return payload.ip;
}

async function probeLogin(index) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let browser;
  try {
    ({ browser } = await loginToPeopleSoft({ headless: true }));
    return {
      attempt: index,
      startedAt,
      ok: true,
      elapsedMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    return {
      attempt: index,
      startedAt,
      ok: false,
      elapsedMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}

if (!config.live) {
  console.log(
    JSON.stringify(
      {
        mode: 'dry-run',
        attempts: config.attempts,
        maxJitterSeconds: config.jitterSeconds,
        command:
          'PHASE0_CONFIRM_LIVE=true node scripts/validate-hosted-portal.mjs',
        note: 'No se abrió PeopleSoft. La confirmación explícita evita pruebas de login accidentales.',
      },
      null,
      2
    )
  );
  process.exit(0);
}

const report = {
  checkedAt: new Date().toISOString(),
  publicIp: null,
  attempts: [],
};

try {
  report.publicIp = await publicIp();
} catch (error) {
  report.publicIpError = error instanceof Error ? error.message : String(error);
}

for (let index = 1; index <= config.attempts; index++) {
  if (index > 1) {
    const delay = jitterDelayMs(config.jitterSeconds);
    console.log(`Esperando ${Math.ceil(delay / 1000)}s antes del login ${index}/${config.attempts}…`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  const result = await probeLogin(index);
  report.attempts.push(result);
  console.log(`${result.ok ? '✓' : '✗'} login ${index}/${config.attempts} (${result.elapsedMs}ms)`);
}

console.log('\nReporte Fase 0 (sin credenciales):');
console.log(JSON.stringify(report, null, 2));

if (report.attempts.some((attempt) => !attempt.ok)) process.exitCode = 1;
