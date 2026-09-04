// El modelo de tiempo (Fase 6): resolver cuál ciclo corre hoy y cuál sigue, con
// fechas reales y sin ellas. Es el gate de la fase: si esto se equivoca, el
// Dashboard vuelve a anunciar como "próxima clase" una materia de septiembre.
import assert from 'node:assert/strict';
import { resolveTerms, cycleLabel, labelFor, isStrmCode, cycleKey } from '../src/shared/terms.ts';

// cycleLabel deriva la etiqueta del MES DE INICIO del término. Los bordes son lo
// que importa: los tres ciclos de PUCMM arrancan en enero, a finales de abril y
// en septiembre. Un inicio en abril es el ciclo de Abril, nunca el de Enero —el
// ciclo de Enero se extiende hasta abril pero jamás EMPIEZA ahí.
assert.equal(cycleLabel(1, 2026), 'Enero de 2026');
assert.equal(cycleLabel(3, 2026), 'Enero de 2026', 'marzo: un inicio en marzo sigue siendo el ciclo de enero');
assert.equal(cycleLabel(4, 2026), 'Abril de 2026', 'un ciclo que empieza en abril es Abril, no Enero');
assert.equal(cycleLabel(5, 2026), 'Abril de 2026');
assert.equal(cycleLabel(8, 2026), 'Abril de 2026', 'agosto es el ciclo de abril (may–ago)');
assert.equal(cycleLabel(9, 2026), 'Septiembre de 2026');
assert.equal(cycleLabel(12, 2026), 'Septiembre de 2026');

// Un STRM que arranca a finales de abril: el bug era etiquetarlo "Enero de 2026".
assert.equal(
  labelFor({ code: '1920', label: null, startDate: '2026-04-28', endDate: '2026-08-15' }),
  'Abril de 2026',
  'una inscripción que arranca el 28 de abril es del ciclo de Abril'
);

// isStrmCode: la frontera entre los dos vocabularios de término.
assert.equal(isStrmCode('1930'), true);
assert.equal(isStrmCode('Abril de 2026'), false, 'una etiqueta no es un STRM');
assert.equal(isStrmCode(null), false);

// cycleKey: dos formas del mismo ciclo comparten llave; un STRM y su etiqueta también.
assert.equal(cycleKey({ code: null, label: 'Abril de 2026', startDate: null, endDate: null }), '2026-04');
assert.equal(
  cycleKey({ code: '1920', label: null, startDate: '2026-04-28', endDate: null }),
  '2026-04',
  'el STRM sin etiqueta se ubica por su fecha de inicio'
);

// labelFor: un STRM sin etiqueta pero con fecha de inicio se nombra por su ciclo.
assert.equal(
  labelFor({ code: '1930', label: null, startDate: '2026-09-01', endDate: '2026-12-07' }),
  'Septiembre de 2026',
  'la etiqueta se deriva de la fecha de inicio del STRM'
);
assert.equal(labelFor({ code: null, label: 'Abril de 2026', startDate: null, endDate: null }), 'Abril de 2026');
assert.equal(labelFor({ code: '9999', label: null, startDate: null, endDate: null }), null, 'sin etiqueta ni fecha, no hay nombre');

const T = (code, label, startDate = null, endDate = null) => ({ code, label, startDate, endDate });

// ── El caso real que motiva la fase ─────────────────────────────────────────
// Hoy es 17-jul-2026. El estudiante cursa "Abril de 2026" (may–ago, solo en
// grades, sin fechas). El único término inscrito es STRM 1930 = "Septiembre de
// 2026" (sep–dic, con fechas). El bug era que 1930 salía como ciclo actual.
{
  const hoy = new Date(2026, 6, 17);
  const r = resolveTerms(
    [
      T('1930', null, '2026-09-01', '2026-12-07'), // STRM sin etiqueta: se deriva
      T(null, 'Abril de 2026'), // label-only, sin fechas → ventana implícita
      T(null, 'Enero de 2026'),
      T(null, 'Septiembre de 2025'),
    ],
    hoy
  );
  assert.equal(r.current?.label, 'Abril de 2026', 'el ciclo que contiene a hoy, aunque no tenga fechas');
  assert.equal(r.current?.code, null);
  assert.equal(r.next?.label, 'Septiembre de 2026', 'el siguiente es el que empieza en septiembre');
  assert.equal(r.next?.code, '1930', 'y arrastra su STRM para poder pedir su horario');
  // La lista sale cronológica.
  assert.deepEqual(
    r.terms.map((t) => t.label),
    ['Septiembre de 2025', 'Enero de 2026', 'Abril de 2026', 'Septiembre de 2026']
  );
}

// ── Con fechas reales ───────────────────────────────────────────────────────
{
  const r = resolveTerms(
    [
      T('1910', 'Enero de 2026', '2026-01-15', '2026-04-30'),
      T('1920', 'Abril de 2026', '2026-05-05', '2026-08-20'),
      T('1930', 'Septiembre de 2026', '2026-09-01', '2026-12-07'),
    ],
    new Date(2026, 5, 15) // 15 de junio → dentro de Abril
  );
  assert.equal(r.current?.code, '1920');
  assert.equal(r.next?.code, '1930');
}

// ── Entre ciclos: hoy cae en un hueco que solo las fechas reales revelan ─────
// Después del 7-dic (fin de 1930) y antes de que empiece enero: no hay ciclo
// corriendo. Mentir con uno terminado sería peor que decir "entre ciclos".
{
  const r = resolveTerms(
    [
      T('1930', 'Septiembre de 2026', '2026-09-01', '2026-12-07'),
      T('1940', 'Enero de 2027', '2027-01-15', '2027-04-30'),
    ],
    new Date(2026, 11, 20) // 20 de diciembre
  );
  assert.equal(r.current, null, 'entre ciclos: current es null');
  assert.equal(r.next?.code, '1940', 'pero el siguiente ya se sabe');
}

// ── Bordes de la ventana ────────────────────────────────────────────────────
{
  const terms = [T('1930', 'Septiembre de 2026', '2026-09-01', '2026-12-07')];
  assert.equal(resolveTerms(terms, new Date(2026, 8, 1)).current?.code, '1930', 'el primer día cuenta');
  assert.equal(resolveTerms(terms, new Date(2026, 11, 7)).current?.code, '1930', 'el último día cuenta');
  assert.equal(resolveTerms(terms, new Date(2026, 11, 8)).current, null, 'un día después ya no');
  assert.equal(resolveTerms(terms, new Date(2026, 7, 31)).next?.code, '1930', 'la víspera lo ve como siguiente');
}

// ── Un término sin fecha ni etiqueta ubicable no se resuelve, pero no rompe ──
{
  const r = resolveTerms([T('9999', null), T(null, 'Abril de 2026')], new Date(2026, 6, 17));
  assert.equal(r.current?.label, 'Abril de 2026');
  assert.equal(r.terms.at(-1)?.code, '9999', 'el irresoluble queda al final de la lista');
}

// Sin términos, todo es null y no explota.
{
  const r = resolveTerms([], new Date(2026, 6, 17));
  assert.equal(r.current, null);
  assert.equal(r.next, null);
  assert.deepEqual(r.terms, []);
}

console.log('✓ resolución de términos (con fechas, sin fechas, entre ciclos, bordes)');
