import assert from 'node:assert/strict';
import { buildDegreePath, chainLengths, termLabelAfter } from '../src/shared/degreePath.ts';
import { planFor } from '../src/shared/pensum/index.ts';

// La ruta a graduación: que el número de ciclos salga de colocar lo que falta en
// el tiempo y no de contar bloques abiertos, que la cadena de prerrequisitos
// imponga su piso, y que la app diga cuál de las dos restricciones manda.

const counts = { required: null, taken: null, needed: null };
const group = (id, kind, label, position, extra = {}) => ({
  id, kind, label, year: null, period: null, satisfied: false, collapsed: false,
  position, units: counts, courses: counts, gpaActual: null, items: [], children: [], ...extra,
});
const item = (code, { candidate = false, units = 3, status = 'pending' } = {}) => ({
  code, subject: code.split('-')[0], catalogNbr: code.split('-')[1] ?? code,
  title: `Materia ${code}`, units, status, takenTerm: null, grade: null,
  courseId: null, offered: true, isCandidate: candidate,
});
const period = (id, year, number, children, satisfied = false) =>
  group(id, 'periodo', `Año ${year} Período ${number}`, id, { year, period: number, satisfied, children });
const curriculum = (periods) => {
  const root = group(0, 'root', 'Pénsum', 0);
  root.children = periods;
  return root;
};
const standing = (approved = [], inProgress = [], approvedUnits = 0) => ({
  approved: new Set(approved), inProgress: new Set(inProgress), approvedUnits,
});
const rule = (code, { prereqs = [], coreqs = [], units = 3, year = 1, period: p = 1 } = {}) => [
  code,
  { code, portalId: code, title: `Materia ${code}`, theory: 3, practice: 0, units, year, period: p, electiveOf: null, prereqs, coreqs },
];
const plan = (rules, extra = {}) => ({
  plan: 'TEST-2020', career: 'PRUEBA', issuedAt: '2020-01-01', totalUnits: 100,
  periods: [], courses: Object.fromEntries(rules), gates: [], notes: [], ...extra,
});

// ── Aritmética de ciclos ────────────────────────────────────────────────────
{
  assert.equal(termLabelAfter('Abril de 2026', 0), 'Abril de 2026');
  assert.equal(termLabelAfter('Abril de 2026', 1), 'Septiembre de 2026');
  assert.equal(termLabelAfter('Septiembre de 2026', 1), 'Enero de 2027', 'septiembre cierra el año');
  assert.equal(termLabelAfter('Enero de 2026', 6), 'Enero de 2028', 'seis ciclos son dos años');
  assert.equal(termLabelAfter(null, 3), null, 'sin ciclo de arranque no se fecha');
  assert.equal(termLabelAfter('un ciclo inventado', 1), null);
}

// ── La cadena de prerrequisitos ─────────────────────────────────────────────
{
  const p = plan([
    rule('ICC-101'),
    rule('ICC-201', { prereqs: ['ICC-101'] }),
    rule('ICC-301', { prereqs: ['ICC-201'] }),
    rule('FIL-100'),
  ]);
  const lengths = chainLengths(['ICC-101', 'ICC-201', 'ICC-301', 'FIL-100'], p);
  assert.equal(lengths.get('ICC-101'), 3, 'la raíz de la cadena arrastra tres ciclos');
  assert.equal(lengths.get('ICC-201'), 2);
  assert.equal(lengths.get('ICC-301'), 1);
  assert.equal(lengths.get('FIL-100'), 1, 'una materia suelta no encadena nada');

  // Un prerrequisito YA APROBADO no encadena: solo cuenta lo que falta.
  const partial = chainLengths(['ICC-201', 'ICC-301'], p);
  assert.equal(partial.get('ICC-201'), 2);

  // Sin plan no hay cadenas conocidas, y eso no puede inventar profundidad.
  const blind = chainLengths(['ICC-101', 'ICC-201'], null);
  assert.equal(blind.get('ICC-101'), 1);
}

// Un ciclo en el grafo (recodificación circular) no puede desbordar la pila.
{
  const circular = plan([rule('A-1', { prereqs: ['B-1'] }), rule('B-1', { prereqs: ['A-1'] })]);
  const lengths = chainLengths(['A-1', 'B-1'], circular);
  assert.ok(lengths.get('A-1') >= 1 && lengths.get('B-1') >= 1, 'el ciclo se corta sin explotar');
}

// ── El bug que motiva el módulo ─────────────────────────────────────────────
// Tres materias sueltas repartidas en seis bloques abiertos. `cyclesLeft` del
// pénsum diría 6 ciclos; la realidad es 1, porque nada encadena y todo cabe.
{
  const periods = [];
  for (let i = 1; i <= 6; i++) {
    periods.push(period(i, i, 1, [group(100 + i, 'obligatorios', 'Obligatorios', 100 + i, {
      items: i <= 3 ? [item(`ICC-${i}00`)] : [item(`ICC-${i}00`, { status: 'taken' })],
    })]));
  }
  const result = buildDegreePath({
    requirements: curriculum(periods),
    plan: plan([rule('ICC-100'), rule('ICC-200'), rule('ICC-300')]),
    standing: standing([], [], 60),
    maxCredits: 18,
    startTerm: 'Enero de 2026',
  });
  assert.equal(result.available, true);
  assert.equal(result.termsRemaining, 1, 'tres materias sin cadena caben en un solo ciclo');
  assert.equal(result.coursesRemaining, 3);
  assert.equal(result.creditsRemaining, 9);
  assert.equal(result.graduationTerm, 'Enero de 2026');
  assert.equal(result.binding, 'ambas', 'con un solo ciclo las dos restricciones lo fijan');
  assert.equal(result.unscheduled.length, 0);
}

// ── El piso de la cadena manda sobre la carga ───────────────────────────────
// Nueve créditos entran de sobra en un ciclo de 18, pero la cadena obliga a tres.
{
  const tree = curriculum([
    period(1, 1, 1, [group(11, 'obligatorios', 'Obligatorios', 11, { items: [item('ICC-101')] })]),
    period(2, 1, 2, [group(12, 'obligatorios', 'Obligatorios', 12, { items: [item('ICC-201')] })]),
    period(3, 1, 3, [group(13, 'obligatorios', 'Obligatorios', 13, { items: [item('ICC-301')] })]),
  ]);
  const p = plan([
    rule('ICC-101'),
    rule('ICC-201', { prereqs: ['ICC-101'] }),
    rule('ICC-301', { prereqs: ['ICC-201'] }),
  ]);
  const result = buildDegreePath({
    requirements: tree, plan: p, standing: standing([], [], 40), maxCredits: 18, startTerm: 'Abril de 2026',
  });
  assert.equal(result.termsRemaining, 3, 'la cadena impone tres ciclos aunque todo quepa en uno');
  assert.equal(result.chainFloor, 3);
  assert.equal(result.loadFloor, 1);
  assert.equal(result.binding, 'prerrequisitos', 'subir la carga no adelantaría nada, y hay que decirlo');
  assert.deepEqual(result.criticalPath.map((c) => c.code), ['ICC-101', 'ICC-201', 'ICC-301']);
  assert.equal(result.graduationTerm, 'Enero de 2027');
  assert.deepEqual(result.terms.map((t) => t.courses.map((c) => c.code)), [['ICC-101'], ['ICC-201'], ['ICC-301']]);
  assert.ok(result.terms.every((t) => t.courses.every((c) => c.critical)), 'toda la cadena está sin holgura');
  assert.equal(result.terms[0].label, 'Abril de 2026');
  assert.equal(result.terms[2].label, 'Enero de 2027');
}

// ── El piso de la carga manda sobre la cadena ───────────────────────────────
{
  const items = Array.from({ length: 8 }, (_, i) => item(`GEN-${100 + i}`));
  const tree = curriculum([period(1, 1, 1, [group(11, 'obligatorios', 'Obligatorios', 11, { items })])]);
  const result = buildDegreePath({
    requirements: tree,
    plan: plan(items.map((it) => rule(it.code))),
    standing: standing([], [], 30),
    maxCredits: 9,
    startTerm: 'Enero de 2026',
  });
  assert.equal(result.creditsRemaining, 24);
  assert.equal(result.chainFloor, 1);
  assert.equal(result.loadFloor, 3);
  assert.equal(result.termsRemaining, 3);
  assert.equal(result.binding, 'carga', 'acá sí adelanta tomar más créditos');
  assert.ok(result.terms.every((t) => t.credits <= 9), 'ningún ciclo pasa el techo');
}

// ── Co-requisitos: teoría y laboratorio entran juntos ───────────────────────
// El laboratorio vale 0 créditos, que es real y no dato faltante.
{
  const tree = curriculum([
    period(1, 1, 1, [group(11, 'obligatorios', 'Obligatorios', 11, {
      items: [item('FIS-219', { units: 4 }), item('FIS-219L', { units: 0 })],
    })]),
  ]);
  const p = plan([
    rule('FIS-219', { coreqs: ['FIS-219L'], units: 4 }),
    rule('FIS-219L', { units: 0 }),
  ]);
  const result = buildDegreePath({
    requirements: tree, plan: p, standing: standing([], [], 30), maxCredits: 18, startTerm: 'Enero de 2026',
  });
  assert.equal(result.termsRemaining, 1);
  const codes = result.terms[0].courses.map((c) => c.code).sort();
  assert.deepEqual(codes, ['FIS-219', 'FIS-219L'], 'el laboratorio no se pierde por valer 0 créditos');
  const lab = result.terms[0].courses.find((c) => c.code === 'FIS-219L');
  assert.equal(lab.requiredBy, 'FIS-219', 'el laboratorio dice de quién cuelga');
}

// Un paquete que no cabe en el ciclo espera entero al siguiente: nunca entra a medias.
{
  const tree = curriculum([
    period(1, 1, 1, [group(11, 'obligatorios', 'Obligatorios', 11, {
      items: [item('MAT-100', { units: 4 }), item('FIS-219', { units: 4 }), item('FIS-219L', { units: 2 })],
    })]),
  ]);
  const p = plan([
    rule('MAT-100', { units: 4 }),
    rule('FIS-219', { coreqs: ['FIS-219L'], units: 4 }),
    rule('FIS-219L', { units: 2 }),
  ]);
  const result = buildDegreePath({
    requirements: tree, plan: p, standing: standing([], [], 30), maxCredits: 6, startTerm: 'Enero de 2026',
  });
  assert.equal(result.termsRemaining, 2);
  for (const term of result.terms) {
    const has = (code) => term.courses.some((c) => c.code === code);
    assert.equal(has('FIS-219'), has('FIS-219L'), 'teoría y laboratorio nunca se separan entre ciclos');
  }
}

// ── Compuertas por porcentaje: se abren solas al avanzar la ruta ────────────
{
  const tree = curriculum([
    period(1, 1, 1, [group(11, 'obligatorios', 'Obligatorios', 11, {
      items: [item('FIL-363', { units: 3 }), item('GEN-1', { units: 30 })],
    })]),
  ]);
  const p = plan(
    [rule('FIL-363', { units: 3 }), rule('GEN-1', { units: 30 })],
    { totalUnits: 100, gates: [{ code: 'FIL-363', minApprovedRatio: 0.7, text: 'FIL-363 exige el 70%' }] }
  );
  const result = buildDegreePath({
    requirements: tree, plan: p, standing: standing([], [], 50), maxCredits: 30, startTerm: 'Enero de 2026',
  });
  assert.equal(result.termsRemaining, 2, 'la compuerta empuja FIL-363 al ciclo siguiente');
  assert.deepEqual(result.terms[0].courses.map((c) => c.code), ['GEN-1']);
  assert.deepEqual(result.terms[1].courses.map((c) => c.code), ['FIL-363']);
}

// Una compuerta que los créditos del plan nunca alcanzan deja la materia fuera,
// con su motivo, en vez de trabar la ruta entera en silencio.
{
  const tree = curriculum([
    period(1, 1, 1, [group(11, 'obligatorios', 'Obligatorios', 11, { items: [item('FIL-363'), item('GEN-1')] })]),
  ]);
  const p = plan(
    [rule('FIL-363'), rule('GEN-1')],
    { totalUnits: 1000, gates: [{ code: 'FIL-363', minApprovedRatio: 0.9, text: 'exige el 90%' }] }
  );
  const result = buildDegreePath({
    requirements: tree, plan: p, standing: standing([], [], 0), maxCredits: 18, startTerm: 'Enero de 2026',
  });
  assert.equal(result.termsRemaining, 1);
  assert.equal(result.unscheduled.length, 1);
  assert.equal(result.unscheduled[0].code, 'FIL-363');
  assert.ok(result.caveats.some((c) => c.includes('fuera de la ruta')), 'lo que no entró se dice en voz alta');
}

// ── Electivas: ocupan créditos, no encadenan, y nunca son críticas ──────────
{
  const tree = curriculum([
    period(1, 1, 1, [
      group(11, 'obligatorios', 'Obligatorios', 11, { items: [item('ICC-101')] }),
      group(12, 'electiva', 'Electivas complementarias', 12, {
        units: { required: 9, taken: 0, needed: 9 },
        courses: { required: 3, taken: 0, needed: 3 },
        items: [item('ELE-1', { candidate: true }), item('ELE-2', { candidate: true })],
      }),
    ]),
  ]);
  const result = buildDegreePath({
    requirements: tree, plan: plan([rule('ICC-101')]), standing: standing([], [], 30),
    maxCredits: 6, startTerm: 'Enero de 2026',
  });
  assert.equal(result.coursesRemaining, 4, 'tres cupos de electiva más la obligatoria');
  assert.equal(result.creditsRemaining, 12, '9 créditos de electiva + 3 de la obligatoria');
  assert.equal(result.termsRemaining, 2);
  const electivas = result.terms.flatMap((t) => t.courses).filter((c) => c.kind === 'electiva');
  assert.equal(electivas.length, 3);
  assert.ok(electivas.every((c) => !c.critical), 'una electiva siempre se puede cambiar: nunca fija la fecha');
  assert.ok(result.caveats.some((c) => c.includes('cupos sin materia elegida')));
  // La obligatoria va primero: lo que encadena tiene prioridad sobre el relleno.
  assert.ok(result.terms[0].courses.some((c) => c.code === 'ICC-101'));
}

// ── Lo que se cursa hoy cuenta, y deja la ruta condicionada ─────────────────
{
  const tree = curriculum([
    period(1, 1, 1, [group(11, 'obligatorios', 'Obligatorios', 11, { items: [item('ICC-201')] })]),
  ]);
  const p = plan([rule('ICC-101'), rule('ICC-201', { prereqs: ['ICC-101'] })]);
  const result = buildDegreePath({
    requirements: tree, plan: p, standing: standing([], ['ICC-101'], 30), maxCredits: 18, startTerm: 'Enero de 2026',
  });
  assert.equal(result.termsRemaining, 1, 'lo que cursás ahora habilita su continuación el ciclo que viene');
  assert.deepEqual(result.terms[0].courses[0].conditionalOn, ['ICC-101']);
  assert.ok(result.caveats.some((c) => c.includes('da por aprobado lo que cursás ahora')));
}

// ── Cuellos de botella: lo que más destraba, primero lo sin holgura ─────────
{
  const tree = curriculum([
    period(1, 1, 1, [group(11, 'obligatorios', 'Obligatorios', 11, {
      items: [item('ICC-104'), item('ICC-203'), item('ICC-303'), item('FIL-100')],
    })]),
  ]);
  const p = plan([
    rule('ICC-104'),
    rule('ICC-203', { prereqs: ['ICC-104'] }),
    rule('ICC-303', { prereqs: ['ICC-203'] }),
    rule('FIL-100'),
  ]);
  const result = buildDegreePath({
    requirements: tree, plan: p, standing: standing([], [], 40), maxCredits: 18, startTerm: 'Enero de 2026',
  });
  assert.equal(result.termsRemaining, 3);
  assert.equal(result.bottlenecks[0].code, 'ICC-104', 'la raíz de la cadena encabeza');
  assert.equal(result.bottlenecks[0].chainLength, 3);
  assert.equal(result.bottlenecks[0].termIndex, 1);
  assert.ok(!result.bottlenecks.some((b) => b.code === 'FIL-100'), 'una materia que no destraba nada no es cuello de botella');
  const suelta = result.terms.flatMap((t) => t.courses).find((c) => c.code === 'FIL-100');
  assert.equal(suelta.critical, false, 'FIL-100 tiene holgura: atrasarla no atrasa la carrera');
}

// ── Bordes ─────────────────────────────────────────────────────────────────
{
  const vacio = buildDegreePath({ requirements: null, plan: null, standing: standing(), maxCredits: 18 });
  assert.equal(vacio.available, false);
  assert.ok(vacio.reason.includes('informe de avance'));

  const cargaMala = buildDegreePath({
    requirements: curriculum([]), plan: null, standing: standing(), maxCredits: 0,
  });
  assert.equal(cargaMala.available, false);
  assert.ok(cargaMala.reason.includes('mayor que cero'));

  const completo = buildDegreePath({
    requirements: curriculum([period(1, 1, 1, [], true)]), plan: null, standing: standing(), maxCredits: 18,
  });
  assert.equal(completo.available, true);
  assert.equal(completo.termsRemaining, 0);
  assert.equal(completo.graduationTerm, null);

  // Sin plan oficial la ruta igual se traza, pero avisa que el orden puede ser más largo.
  const tree = curriculum([
    period(1, 1, 1, [group(11, 'obligatorios', 'Obligatorios', 11, { items: [item('ICC-101'), item('ICC-201')] })]),
  ]);
  const ciego = buildDegreePath({
    requirements: tree, plan: null, standing: standing([], [], 30), maxCredits: 18, startTerm: 'Enero de 2026',
  });
  assert.equal(ciego.termsRemaining, 1);
  assert.ok(ciego.caveats.some((c) => c.includes('no se pueden verificar prerrequisitos')));
}

// ── Determinismo ───────────────────────────────────────────────────────────
{
  const tree = curriculum([
    period(1, 1, 1, [group(11, 'obligatorios', 'Obligatorios', 11, {
      items: [item('ICC-101'), item('MAT-110'), item('FIS-139'), item('LET-101')],
    })]),
  ]);
  const p = plan([rule('ICC-101'), rule('MAT-110'), rule('FIS-139'), rule('LET-101')]);
  const args = { requirements: tree, plan: p, standing: standing([], [], 30), maxCredits: 6, startTerm: 'Enero de 2026' };
  const a = buildDegreePath(args);
  const b = buildDegreePath(args);
  assert.deepEqual(
    a.terms.map((t) => t.courses.map((c) => c.code)),
    b.terms.map((t) => t.courses.map((c) => c.code)),
    'dos corridas con los mismos datos dan la misma ruta'
  );
}

// ── Contra el plan real de ICC-2020 ────────────────────────────────────────
{
  const real = planFor({ pensumNo: '2020', career: 'INGENIERÍA EN CIENCIAS DE LA COMPUTACIÓN' });
  assert.ok(real, 'el plan ICC-2020 está en la app');

  // Un estudiante de primer año: nada aprobado, todo el pénsum por delante.
  const periods = real.periods.map((p, i) =>
    period(i + 1, p.year, p.period, [
      group(1000 + i, 'obligatorios', 'Obligatorios', 1000 + i, {
        items: Object.values(real.courses)
          .filter((c) => c.year === p.year && c.period === p.period && !c.electiveOf)
          .map((c) => item(c.code, { units: c.units })),
      }),
    ])
  );
  const result = buildDegreePath({
    requirements: curriculum(periods),
    plan: real,
    standing: standing([], [], 0),
    maxCredits: 18,
    startTerm: 'Enero de 2026',
  });
  assert.equal(result.available, true);
  assert.ok(result.termsRemaining >= result.chainFloor, 'la ruta nunca es más corta que su cadena');
  assert.ok(result.termsRemaining >= result.loadFloor, 'la ruta nunca es más corta que su carga');
  assert.ok(result.criticalPath.length >= 2, 'un pénsum de ingeniería tiene cadenas reales');
  assert.ok(
    result.terms.every((t) => t.credits <= 18),
    'ningún ciclo de la ruta real pasa el techo de créditos'
  );
  // Ninguna materia se coloca antes que su prerrequisito.
  const termOf = new Map(result.terms.flatMap((t) => t.courses.map((c) => [c.code, t.index])));
  for (const [code, index] of termOf) {
    for (const prereq of real.courses[code]?.prereqs ?? []) {
      const before = termOf.get(prereq);
      if (before == null) continue;
      assert.ok(before < index, `${prereq} tiene que ir antes que ${code} (${before} vs ${index})`);
    }
  }

  console.log(
    `✓ ruta a graduación: cadena vs carga, co-requisitos atómicos, compuertas, electivas como cupos y ` +
      `determinismo; ICC-2020 completo: ${result.termsRemaining} ciclos · ${result.creditsRemaining} créditos · ` +
      `cadena crítica de ${result.criticalPath.length} (${result.criticalPath.map((c) => c.code).join(' → ')})`
  );
}
