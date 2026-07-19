// Gate explícito para Fase 7. No inicia Playwright, no toca PeopleSoft y no
// imprime secretos. La verificación online solo consulta DNS y /api/health.
import assert from 'node:assert/strict';
import { lookup } from 'node:dns/promises';

const online = process.argv.includes('--online');
const errors = [];
const notices = [];

function required(name, predicate = (value) => Boolean(value?.trim())) {
  const value = process.env[name] ?? '';
  if (!predicate(value)) errors.push(`${name} no está configurada correctamente`);
  return value;
}

const domain = required('DOMAIN', (value) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9-]+)+$/i.test(value));
const expectedIp = required('MIKAMPUS_EXPECTED_IPV4', (value) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value));
required('MIKAMPUS_MODE', (value) => value === 'hosted');
required('MIKAMPUS_ALLOWLIST');
required('MIKAMPUS_CRED_KEY', (value) => /^[0-9a-f]{64}$/i.test(value));
required('MIKAMPUS_VAPID_PUBLIC');
required('MIKAMPUS_VAPID_PRIVATE');
required('MIKAMPUS_VAPID_SUBJECT', (value) => /^(mailto:|https:\/\/)/.test(value));
required('MIKAMPUS_OPERATOR_NTFY_TOPIC');
required('TZ', (value) => value === 'America/Santo_Domingo');
required('LITESTREAM_ENABLED', (value) => value === 'true');
required('LITESTREAM_BUCKET');
required('LITESTREAM_ENDPOINT', (value) => /^https:\/\//.test(value));
required('LITESTREAM_ACCESS_KEY_ID');
required('LITESTREAM_SECRET_ACCESS_KEY');
required('LITESTREAM_AGE_RECIPIENT', (value) => value.startsWith('age1'));

if (process.env.MIKAMPUS_BACKUP_KEEP !== '3') {
  notices.push('MIKAMPUS_BACKUP_KEEP no es 3; el plan declara una retención local de tres días');
}

if (errors.length) {
  console.error('✗ Gate de lanzamiento bloqueado:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exitCode = 1;
} else {
  console.log('✓ Configuración hosted completa (sin revelar valores).');
}

for (const notice of notices) console.warn(`! ${notice}`);

if (online && !errors.length) {
  try {
    const addresses = await lookup(domain, { family: 4, all: true });
    assert.ok(addresses.some(({ address }) => address === expectedIp), 'el A record no apunta a MIKAMPUS_EXPECTED_IPV4');
    console.log('✓ DNS definitivo apunta a la IPv4 reservada esperada.');

    const response = await fetch(`https://${domain}/api/health`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.ok, true, `GET /api/health devolvió HTTP ${response.status}`);
    const payload = await response.json();
    assert.equal(payload.ok, true, 'la respuesta de salud no confirmó ok=true');
    console.log('✓ HTTPS y /api/health responden correctamente.');
  } catch (error) {
    console.error(`✗ Verificación online bloqueada: ${error.message}`);
    process.exitCode = 1;
  }
}
