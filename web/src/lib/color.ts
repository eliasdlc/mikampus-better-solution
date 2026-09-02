// Principio #4 del plan: cada materia tiene un color estable en toda la app,
// derivado de su código. 14 hues equidistantes en OKLCH (misma L y C para
// todas), asignados por hash del código — la misma materia se ve del mismo
// color en búsqueda, planner, builder, horario y carrito.
const HUE_COUNT = 14;

function hash(code: string): number {
  let h = 2166136261;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function courseHue(code: string): number {
  return (hash(code) % HUE_COUNT) * (360 / HUE_COUNT);
}

// light-dark() elige la variante según color-scheme (que fijamos en :root/.dark),
// así el mismo string sirve en ambos temas sin recalcular en JS.
export function courseColor(code: string): string {
  const hue = courseHue(code).toFixed(1);
  return `light-dark(oklch(0.72 0.11 ${hue}), oklch(0.68 0.13 ${hue}))`;
}

// El mismo par de tonos que courseColor, pero con el hue dado en vez de
// hasheado: lo usa el WeeklyGrid cuando reparte tonos sobre las materias
// visibles (ver paletteFor en lib/grid.ts).
export function hueColor(hue: number): string {
  const h = hue.toFixed(1);
  return `light-dark(oklch(0.72 0.11 ${h}), oklch(0.68 0.13 ${h}))`;
}
