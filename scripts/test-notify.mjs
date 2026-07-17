// La política de notificaciones (src/notify.js), sin popups: noticeFor es pura
// a propósito para poder verificar acá qué interrumpe al usuario y qué no.
//
// Lo que protege: que la app no se vuelva ruido. Una app que notifica todo se
// silencia entera, y ese día se pierde la única notificación que importaba.
import assert from 'node:assert/strict';
import { noticeFor } from '../src/notify.js';

const enroll = (results, reason = 'hora programada') => ({ type: 'enroll-result', results, reason });
const ok = (classLabel) => ({ classLabel, message: 'Success', success: true });
const fail = (classLabel, message = 'Error: Class 4567 is full') => ({ classLabel, message, success: false });

// Inscribirse es LA noticia por la que existe la app: critical, que en mako es
// la que no se auto-cierra mientras estás en otra ventana.
const inscrito = noticeFor(enroll([ok('ICC ICC303-101')]));
assert.equal(inscrito.title, '¡Inscrito!');
assert.equal(inscrito.urgency, 'critical');
assert.match(inscrito.body, /ICC303-101/);

// Un intento fallido a la hora programada es lo esperado (todavía no hay cupo):
// va al feed, no a la cara.
assert.equal(noticeFor(enroll([fail('ICC ICC303-101')])), null);

// Pero si el watcher VIO cupo y aun así no entraste, alguien fue más rápido y
// eso es justo lo que necesitás saber para decidir a mano.
const perdido = noticeFor(enroll([fail('ICC ICC303-101')], 'cupo detectado'));
assert.equal(perdido.title, 'Apareció cupo pero no entraste');
assert.equal(perdido.urgency, 'critical');

// Éxito parcial: lo que entró es noticia aunque algo más haya fallado.
const parcial = noticeFor(enroll([ok('ICC ICC303-101'), fail('MAT MAT241-102')], 'cupo detectado'));
assert.equal(parcial.title, '¡Inscrito!');
assert.match(parcial.body, /ICC303-101/);
assert.doesNotMatch(parcial.body, /MAT241/, 'el cuerpo lista lo inscrito, no lo que falló');

// Los errores interrumpen; el progreso no.
const error = noticeFor({ type: 'notice', level: 'error', title: 'El watcher no pudo leer el carrito', body: 'timeout', key: 'watcher-cart-error' });
assert.equal(error.urgency, 'critical');
assert.equal(error.key, 'watcher-cart-error');

assert.equal(noticeFor({ type: 'log', message: 'Agregando ICC-303 al carrito…' }), null, 'el progreso vive en el feed');
assert.equal(noticeFor({ type: 'cart-status', rows: [] }), null);
assert.equal(noticeFor({ type: 'watcher-set', enabled: true }), null);

// Sin key explícita hay una derivada del título: el dedupe necesita agrupar
// SIEMPRE, o un error repetido cada 45s son 80 popups por hora.
const sinKey = noticeFor({ type: 'notice', level: 'info', title: 'Catálogo actualizado' });
assert.equal(sinKey.key, 'notice:Catálogo actualizado');
assert.equal(sinKey.urgency, 'normal');

console.log('✓ política de notificaciones (qué interrumpe, qué va al feed, y con qué urgencia)');
