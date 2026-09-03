// Los redirects del workspace unificado (P2). Fusionar Planear dentro de
// Inscripción no puede romper un bookmark viejo ni perder el plan que traía.
import assert from 'node:assert/strict';

const { legacyPlanTarget, isStage } = await import('../web/src/lib/legacyRoutes.ts');

// ── Cada camino viejo cae en su etapa equivalente ──────────────────────────
assert.equal(legacyPlanTarget('/planear'), '/inscripcion', 'planear sin tab abre la primera etapa');
assert.equal(legacyPlanTarget('/planear', '?tab=materias'), '/inscripcion', 'materias era el plan');
assert.equal(legacyPlanTarget('/planear', '?tab=horario'), '/inscripcion?etapa=grupos', 'horario era elegir grupos');
assert.equal(legacyPlanTarget('/planner'), '/inscripcion', 'planner era la lista de materias');
assert.equal(legacyPlanTarget('/builder'), '/inscripcion?etapa=grupos', 'builder era el armado de horario');

// El default no se escribe en la URL: el enlace que la persona comparte queda
// limpio y sigue significando lo mismo.
assert.ok(!legacyPlanTarget('/planner').includes('etapa='), 'la primera etapa no ensucia la URL');

// ── El contexto viaja con el salto ─────────────────────────────────────────
assert.equal(
  legacyPlanTarget('/planear', '?tab=horario&plan=7'),
  '/inscripcion?etapa=grupos&plan=7',
  'el plan abierto sobrevive al redirect'
);
assert.equal(legacyPlanTarget('/builder', '?plan=12'), '/inscripcion?etapa=grupos&plan=12');
assert.equal(legacyPlanTarget('/planner', '?plan=3'), '/inscripcion?plan=3', 'plan sin etapa tampoco se pierde');

// Un plan vacío o ausente no inventa un parámetro.
assert.equal(legacyPlanTarget('/planear', '?plan='), '/inscripcion', 'un plan vacío no viaja');

// El ciclo no existía en las rutas viejas, pero si viene escrito a mano se
// respeta: es el contexto del que cuelga todo lo demás en el workspace.
assert.equal(legacyPlanTarget('/planear', '?ciclo=2245'), '/inscripcion?ciclo=2245');
assert.equal(
  legacyPlanTarget('/builder', '?plan=4&ciclo=2245'),
  '/inscripcion?etapa=grupos&plan=4&ciclo=2245',
  'etapa, plan y ciclo conviven'
);

// ── Acepta URLSearchParams además de string ────────────────────────────────
assert.equal(
  legacyPlanTarget('/planear', new URLSearchParams({ tab: 'horario' })),
  '/inscripcion?etapa=grupos',
  'el router entrega URLSearchParams, no un string'
);

// ── Basura entra, default sale (nunca un 404 ni una etapa inventada) ───────
assert.equal(legacyPlanTarget('/planear', '?tab=loquesea'), '/inscripcion', 'un tab desconocido cae en la primera etapa');
assert.equal(legacyPlanTarget('/otra-cosa'), '/inscripcion', 'cualquier ruta legada termina en el workspace');

// ── El guard de etapa solo acepta las tres reales ──────────────────────────
assert.ok(isStage('plan') && isStage('grupos') && isStage('carrito'));
assert.ok(!isStage('materias'), 'la etapa vieja ya no es válida');
assert.ok(!isStage(null) && !isStage(undefined) && !isStage('horario'));

// /mesa se absorbió en la etapa "grupos". Era un destino primario con
// bookmarks propios, y llevaba el ciclo en `?term`, no en `?ciclo`.
assert.equal(legacyPlanTarget('/mesa'), '/inscripcion?etapa=grupos', 'la mesa es la etapa de grupos');
assert.equal(
  legacyPlanTarget('/mesa', '?term=1930'),
  '/inscripcion?etapa=grupos&ciclo=1930',
  'y su ciclo viaja aunque se llamara distinto'
);
assert.equal(
  legacyPlanTarget('/mesa', '?plan=7&ciclo=1940'),
  '/inscripcion?etapa=grupos&plan=7&ciclo=1940',
  'el plan abierto no se pierde en el camino'
);

console.log('✓ rutas legadas: planear/planner/builder/mesa caen en su etapa del workspace sin perder plan ni ciclo');
