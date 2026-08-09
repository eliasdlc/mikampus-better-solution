import assert from 'node:assert/strict';
import { evaluate, coreqClosure, missingCoreqs, unlockCount, equivalents } from '../src/shared/eligibility.ts';
import { isApproved, isPassing } from '../src/shared/gpa.ts';

const rule = (code, extra = {}) => ({
  code, portalId: '000000', title: code, theory: 3, practice: 0, units: 4,
  year: 1, period: 1, electiveOf: null, prereqs: [], coreqs: [], ...extra,
});

const plan = {
  plan: 'ICC-2020',
  career: 'ICC',
  issuedAt: '2024-12-03',
  totalUnits: 200,
  periods: [],
  gates: [{ code: 'FIL-363', minApprovedRatio: 0.7, text: '70%' }],
  notes: [],
  aliases: { 'MAT-110': ['ESG-105'] },
  courses: {
    'MAT-129': rule('MAT-129'),
    'MAT-110': rule('MAT-110'),
    'FIS-139': rule('FIS-139', { prereqs: ['MAT-129'], coreqs: ['FIS-1FIS139'] }),
    'FIS-1FIS139': rule('FIS-1FIS139', { prereqs: ['MAT-129'], coreqs: ['FIS-139'], units: 0 }),
    'FIS-219': rule('FIS-219', { prereqs: ['FIS-139', 'FIS-1FIS139'], coreqs: ['FIS-1FIS219'] }),
    'FIS-1FIS219': rule('FIS-1FIS219', { prereqs: ['FIS-139'], coreqs: ['FIS-219'], units: 0 }),
    'ICC-212': rule('ICC-212', { prereqs: ['ICC-211'] }),
    'ICC-211': rule('ICC-211'),
    // Prerrequisito que el plan arrastra de otra versión y no define: el
    // reporte real trae MAT-311 e ITT-344, que no existen en ICC-2020.
    'MAT-130': rule('MAT-130', { prereqs: ['MAT-119', 'MAT-311'] }),
    'MAT-119': rule('MAT-119'),
    'FIL-363': rule('FIL-363', { units: 3 }),
  },
};

const standing = ({ approved = [], inProgress = [], approvedUnits = 0 } = {}) => ({
  approved: new Set(approved),
  inProgress: new Set(inProgress),
  approvedUnits,
});

// ── Prerrequisitos ──────────────────────────────────────────────────────────
{
  const sin = evaluate(plan, 'ICC-212', standing());
  assert.equal(sin.eligible, false);
  assert.deepEqual(sin.blockers, [{ kind: 'prereq', code: 'ICC-211', approved: false }]);

  const con = evaluate(plan, 'ICC-212', standing({ approved: ['ICC-211'] }));
  assert.equal(con.eligible, true);
}

// Una materia EN CURSO satisface el prerrequisito de un ciclo futuro, pero deja
// el plan condicionado — y eso se dice, no se esconde.
{
  const cursando = evaluate(plan, 'ICC-212', standing({ inProgress: ['ICC-211'] }));
  assert.equal(cursando.eligible, true);
  assert.deepEqual(cursando.conditionalOn, ['ICC-211']);
}

// Un prerrequisito que el propio plan no define no puede bloquear: nadie podría
// aprobarlo nunca, y bloquear por él dejaría MAT-130 fuera para siempre.
{
  const r = evaluate(plan, 'MAT-130', standing({ approved: ['MAT-119'] }));
  assert.equal(r.eligible, true, 'MAT-311 no existe en el plan: no puede bloquear');
}

// ── Co-requisitos: teoría y laboratorio ─────────────────────────────────────
{
  // Sola, la teoría no es válida: le falta su otra mitad.
  const sola = evaluate(plan, 'FIS-139', standing({ approved: ['MAT-129'] }));
  assert.equal(sola.eligible, false);
  assert.deepEqual(sola.requiresAlongside, ['FIS-1FIS139']);

  // Con el laboratorio en el mismo ciclo, sí.
  const junta = evaluate(plan, 'FIS-139', standing({ approved: ['MAT-129'] }), ['FIS-1FIS139']);
  assert.equal(junta.eligible, true);

  // Y si el laboratorio ya está aprobado de un intento anterior, tampoco hay
  // que repetirlo: es el caso de quien reprobó la teoría y pasó el lab.
  const labHecho = evaluate(plan, 'FIS-139', standing({ approved: ['MAT-129', 'FIS-1FIS139'] }));
  assert.equal(labHecho.eligible, true);
  assert.deepEqual(labHecho.requiresAlongside, []);
}

// ── Cierre de co-requisitos ─────────────────────────────────────────────────
{
  assert.deepEqual(coreqClosure(plan, ['FIS-139']).sort(), ['FIS-139', 'FIS-1FIS139']);
  assert.deepEqual(coreqClosure(plan, ['FIS-1FIS219']).sort(), ['FIS-1FIS219', 'FIS-219']);
  assert.deepEqual(coreqClosure(plan, ['ICC-211']), ['ICC-211']);
  assert.deepEqual(missingCoreqs(plan, 'FIS-139', ['FIS-139']), ['FIS-1FIS139']);
  assert.deepEqual(missingCoreqs(plan, 'FIS-139', ['FIS-139', 'FIS-1FIS139']), []);
  // Sin plan no hay reglas y por lo tanto no hay nada que exigir.
  assert.deepEqual(coreqClosure(null, ['FIS-139']), ['FIS-139']);
}

// ── Compuertas por porcentaje ───────────────────────────────────────────────
{
  const temprano = evaluate(plan, 'FIL-363', standing({ approvedUnits: 100 }));
  assert.equal(temprano.eligible, false);
  assert.equal(temprano.blockers[0].kind, 'gate');

  const tarde = evaluate(plan, 'FIL-363', standing({ approvedUnits: 140 }));
  assert.equal(tarde.eligible, true, '140 de 200 es el 70% exacto');
}

// ── Recodificaciones ────────────────────────────────────────────────────────
// La universidad renombró la misma materia entre versiones del plan. La
// equivalencia funciona en las dos direcciones o el estudiante queda debiendo
// algo que ya aprobó.
{
  assert.deepEqual(equivalents(plan, 'MAT-110').sort(), ['ESG-105', 'MAT-110']);
  assert.deepEqual(equivalents(plan, 'ESG-105').sort(), ['ESG-105', 'MAT-110']);
  const conAlias = evaluate(plan, 'MAT-110', standing({ approved: ['ESG-105'] }));
  assert.equal(conAlias.eligible, true);
}

// ── Lo que el plan no conoce no se bloquea ──────────────────────────────────
// El PDF es una foto fechada y la universidad crea electivas nuevas. Callar una
// materia real es peor que proponer una que el portal rechazará con su mensaje.
{
  const desconocida = evaluate(plan, 'ICC-999', standing());
  assert.equal(desconocida.eligible, true);
  assert.equal(desconocida.unknown, true);

  const sinPlan = evaluate(null, 'FIS-219', standing());
  assert.equal(sinPlan.eligible, true);
  assert.equal(sinPlan.unknown, true);
}

// ── Cuellos de botella ──────────────────────────────────────────────────────
{
  assert.equal(unlockCount(plan, 'FIS-139'), 2, 'FIS-219 y su laboratorio');
  assert.equal(unlockCount(plan, 'FIL-363'), 0);
  assert.equal(unlockCount(null, 'FIS-139'), 0);
}

// ── Aprobada no es lo mismo que cuenta para el índice ───────────────────────
// S (satisfactorio, la nota de los labs) y EXO (exonerada) aprueban sin entrar
// al índice. F y R no aprueban nada, aunque el histórico las liste cursadas:
// contarlas era lo que hacía proponer Física II a quien debe Física I.
{
  for (const grade of ['A', 'B', 'C', 'D', 'S', 'EXO', 's', 'exo']) {
    assert.equal(isApproved(grade), true, `${grade} aprueba`);
  }
  for (const grade of ['F', 'R', null, undefined, '', 'W']) {
    assert.equal(isApproved(grade), false, `${grade} no aprueba`);
  }
  // isPassing no cambia: sigue midiendo el índice y da los 131 créditos
  // "Passed" que el portal calcula.
  assert.equal(isPassing('S'), false);
  assert.equal(isPassing('EXO'), false);
  assert.equal(isPassing('D'), true);
  assert.equal(isPassing('F'), false);
}

console.log('✓ elegibilidad: prerrequisitos, co-requisitos de laboratorio, compuertas, alias y lo desconocido que no bloquea');
