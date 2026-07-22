import assert from 'node:assert/strict';
import { scrub } from './make-fixture.mjs';

const fixture = `
  <input value="session-before-id" name="ICSID" type="hidden">
  <input id="ICStateNum" type="hidden" value="session-after-id">
  <input name="unrelated" value="keep-me">
  <a href="/portal?EMPLID=12345678">Student</a>
  <script>var state = {EMPLID:"12345678", ENRL_REQUEST_ID:"9876543210"}</script>
  <div id="DERIVED_SSTSNAV_PERSON_NAME">ELÍAS DE PRUEBA</div>
`;

const result = scrub(fixture);
assert.equal((result.match(/SCRUBBED_FOR_FIXTURE/g) ?? []).length, 2, 'scrubs sensitive fields in either attribute order');
assert.ok(!result.includes('session-before-id'));
assert.ok(!result.includes('session-after-id'));
assert.ok(result.includes('value="keep-me"'), 'preserves unrelated inputs');
assert.ok(!result.includes('12345678'), 'scrubs student identifiers');
assert.ok(!result.includes('9876543210'), 'scrubs enrollment request identifiers');
assert.ok(!result.includes('ELÍAS DE PRUEBA'), 'scrubs student names');

console.log('✓ sanitizer de fixtures (atributos en cualquier orden y PII)');
