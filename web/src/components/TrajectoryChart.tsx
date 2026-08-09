import { useId, useState } from 'react';
import type { TermGrades } from '../../../src/shared/schemas.ts';
import { cumulativeSeries, type TrajectoryPoint } from '../../../src/shared/projection.ts';

// La trayectoria del índice (P5 §5).
//
// Antes era un sparkline de 132×34 sin ejes, sin detalle y sin acumulado: se
// veía la forma del índice de cada período suelto, que sube y baja mucho más
// que tu récord real y por eso alarmaba de más. Ahora la serie principal es el
// **acumulado tras cada ciclo** —la línea que de verdad cuenta la historia— y
// el índice del período queda como serie secundaria opcional.
//
// Sin librería nueva: SVG y React, como manda la decisión 7 del plan. El precio
// de una librería de charts es un bundle grande y accesibilidad ajena; el
// beneficio acá sería cero, porque son dos líneas y una escala fija.

const WIDTH = 720;
const HEIGHT = 220;
const PAD = { top: 12, right: 12, bottom: 28, left: 30 };
const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;

// Escala fija 0–4 siempre. Con escala automática, un índice que se mueve entre
// 2.6 y 2.8 se dibuja como una montaña rusa y miente sobre su propia magnitud.
const MAX = 4;
const GRID = [0, 1, 2, 3, 4];

export function TrajectoryChart({ terms }: { terms: TermGrades[] }) {
  const titleId = useId();
  const [active, setActive] = useState<number | null>(null);
  const [showTermSeries, setShowTermSeries] = useState(true);

  const series = cumulativeSeries(
    terms.map((term) => ({
      term: term.term,
      sortKey: term.sortKey,
      gpa: term.gpa,
      unitsTowardGpa: term.unitsTowardGpa,
      gradePoints: term.gradePoints,
    }))
  );

  if (series.length < 2) {
    return (
      <p className="border-line text-muted rounded-[var(--radius)] border border-dashed p-4 text-sm">
        Con un solo ciclo calificado todavía no hay trayectoria que dibujar.
      </p>
    );
  }

  const x = (i: number) => PAD.left + (i / (series.length - 1)) * PLOT_W;
  const y = (value: number) => PAD.top + PLOT_H - (Math.min(Math.max(value, 0), MAX) / MAX) * PLOT_H;

  const path = (values: (number | null)[]) => {
    let started = false;
    return values
      .map((value, index) => {
        if (value === null) return '';
        const command = started ? 'L' : 'M';
        started = true;
        return `${command} ${x(index).toFixed(1)} ${y(value).toFixed(1)}`;
      })
      .filter(Boolean)
      .join(' ');
  };

  const point = active !== null ? series[active] : series[series.length - 1];

  // El resumen accesible dice lo mismo que la gráfica: un lector de pantalla no
  // debería tener que adivinar la forma de una línea.
  const summary = `Índice acumulado por ciclo, escala 0 a 4. ${series
    .map((entry) => `${entry.term}: acumulado ${entry.cumulative.toFixed(2)}`)
    .join('. ')}.`;

  return (
    <figure className="border-line bg-surface space-y-3 rounded-[var(--radius)] border p-4">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={titleId} className="text-sm font-medium">
          Tu índice a lo largo de la carrera
        </h3>
        <label className="text-muted flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={showTermSeries}
            onChange={(event) => setShowTermSeries(event.target.checked)}
          />
          Mostrar el índice de cada ciclo
        </label>
      </figcaption>

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="h-auto w-full min-w-[520px]"
          role="img"
          aria-labelledby={titleId}
          aria-describedby={`${titleId}-desc`}
        >
          {/* Líneas de referencia: 2.0 suele ser el mínimo para no caer en
              prueba académica y 3.0 el umbral de honores. Se dibujan sin
              etiquetarlas como reglas oficiales — mikampus no las inventa. */}
          {GRID.map((value) => (
            <g key={value}>
              <line
                x1={PAD.left}
                x2={WIDTH - PAD.right}
                y1={y(value)}
                y2={y(value)}
                stroke="var(--line)"
                strokeWidth={value === 0 ? 1.5 : 1}
                strokeDasharray={value === 0 ? undefined : '3 4'}
              />
              <text x={4} y={y(value) + 4} className="fill-[var(--muted)] text-[11px]">
                {value}
              </text>
            </g>
          ))}

          {showTermSeries && (
            <path
              d={path(series.map((entry) => entry.termGpa))}
              fill="none"
              stroke="var(--muted)"
              strokeWidth="1.5"
              strokeDasharray="4 3"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}

          <path
            d={path(series.map((entry) => entry.cumulative))}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {series.map((entry, index) => (
            <g key={entry.term}>
              <circle
                cx={x(index)}
                cy={y(entry.cumulative)}
                r={active === index ? 5 : 3.5}
                fill="var(--accent)"
              />
              {/* Un blanco generoso e invisible por punto: en touch, un radio de
                  3.5px es imposible de acertar con el dedo. */}
              <circle
                cx={x(index)}
                cy={PAD.top + PLOT_H / 2}
                r={Math.max(14, PLOT_W / series.length / 2)}
                fill="transparent"
                tabIndex={0}
                role="button"
                aria-label={`${entry.term}: acumulado ${entry.cumulative.toFixed(2)}, índice del ciclo ${
                  entry.termGpa === null ? 'sin calificar' : entry.termGpa.toFixed(2)
                }, ${entry.unitsTowardGpa} créditos al índice`}
                className="focus-visible:outline-accent cursor-pointer focus-visible:outline-2"
                onMouseEnter={() => setActive(index)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(index)}
                onBlur={() => setActive(null)}
                onClick={() => setActive(index)}
              />
            </g>
          ))}

          <text x={PAD.left} y={HEIGHT - 8} className="fill-[var(--muted)] text-[11px]">
            {series[0].term}
          </text>
          <text x={WIDTH - PAD.right} y={HEIGHT - 8} textAnchor="end" className="fill-[var(--muted)] text-[11px]">
            {series[series.length - 1].term}
          </text>
        </svg>
      </div>

      {/* El mismo detalle que el hover, pero como texto persistente: es lo que
          hace que teclado, mouse y dedo reciban exactamente lo mismo. */}
      <Detail point={point} isLatest={active === null} />

      <p id={`${titleId}-desc`} className="sr-only">
        {summary}
      </p>
    </figure>
  );
}

function Detail({ point, isLatest }: { point: TrajectoryPoint; isLatest: boolean }) {
  return (
    <div className="border-line flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t pt-3 text-xs" aria-live="polite">
      <span className="font-medium">
        {point.term}
        {isLatest && <span className="text-muted font-normal"> · último</span>}
      </span>
      <span>
        <span className="text-muted">acumulado </span>
        <span className="tabular font-mono">{point.cumulative.toFixed(2)}</span>
      </span>
      <span>
        <span className="text-muted">este ciclo </span>
        <span className="tabular font-mono">{point.termGpa === null ? '—' : point.termGpa.toFixed(2)}</span>
      </span>
      <span className="text-muted tabular font-mono">
        {point.unitsTowardGpa} cr · {point.cumulativeUnits} acum.
      </span>
    </div>
  );
}
