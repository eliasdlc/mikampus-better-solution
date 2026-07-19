import assert from 'node:assert/strict';
import { jitterDelayMs, probeConfig } from '../src/phase0.js';

assert.deepEqual(probeConfig({}), { attempts: 5, jitterSeconds: 90, live: false });
assert.deepEqual(probeConfig({ PHASE0_LOGIN_ATTEMPTS: '3', PHASE0_JITTER_SECONDS: '12', PHASE0_CONFIRM_LIVE: 'true' }), {
  attempts: 3,
  jitterSeconds: 12,
  live: true,
});
assert.throws(() => probeConfig({ PHASE0_LOGIN_ATTEMPTS: '0' }), /PHASE0_LOGIN_ATTEMPTS/);
assert.throws(() => probeConfig({ PHASE0_JITTER_SECONDS: '1.5' }), /PHASE0_JITTER_SECONDS/);
assert.equal(jitterDelayMs(90, () => 0), 0);
assert.equal(jitterDelayMs(90, () => 0.5), 45_000);
assert.equal(jitterDelayMs(90, () => 0.999), 89_910);

console.log('✓ configuración segura del probe de Fase 0');
