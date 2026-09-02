import { useMemo, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import {
  fetchGrades,
  syncGrades,
  fetchRequirements,
  syncPensum,
  fetchGoals,
  createGoal,
  deleteGoal,
  fetchInsights,
} from '../lib/api.ts';
import { CourseChip } from '../components/CourseChip.tsx';
import { TrajectoryChart } from '../components/TrajectoryChart.tsx';
import { StalenessTag } from '../components/StalenessTag.tsx';
import { GRADE_POINTS, formatGpa, roundGpa, summarizeGrades } from '../../../src/shared/gpa.ts';
import type {
  GradesResponse,
  RequirementsResponse,
  RequirementGroup,
  RequirementItem,
  TermGrades,
  GoalsResponse,
  GoalEvaluation,
  Insight,
  ProjectionReport,
} from '../../../src/shared/schemas.ts';

// Notas y avance (plan §5.6). Dos tabs: el histórico con el índice y el
// simulador what-if, y el pénsum con el estado de cada materia.

function BigNumber({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-muted text-xs tracking-wide uppercase">{label}</div>
      <div className="font-display tabular text-3xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="text-muted tabular mt-0.5 text-xs">{hint}</div>}
    </div>
  );
}

// El simulador: notas hipotéticas para lo que estás cursando → índice
// proyectado. Puro cálculo local con la misma aritmética que el sync usa para
// reproducir los totales del portal, así que el número proyectado y el real no
// pueden discrepar.
function WhatIf({ data }: { data: GradesResponse }) {
  const enCurso = useMemo(
    () => data.terms.flatMap((t) => t.courses).filter((c) => c.status === 'in_progress'),
    [data]
  );
  const [hipo, setHipo] = useState<Record<string, string>>({});

  if (!enCurso.length) {
    return (
      <p className="text-muted text-sm">
        El simulador aparece cuando tengas materias en curso: proyecta tu índice sobre notas hipotéticas.
      </p>
    );
  }

  const proyectadas = enCurso.map((c) => ({
    units: c.units,
    grade: hipo[c.code] ?? null,
    status: 'taken' as const,
  }));
  const extra = summarizeGrades(proyectadas.filter((p) => p.grade));
  const puntos = data.summary.gradePoints + extra.gradePoints;
  const creditos = data.summary.unitsTowardGpa + extra.unitsTowardGpa;
  const proyectado = creditos > 0 ? puntos / creditos : null;
  // El delta se calcula sobre los índices YA redondeados, no sobre los exactos:
  // el índice oficial del estudiante es el que publica el portal (un decimal),
  // y un delta exacto contra números redondeados no cierra en pantalla — decía
  // "2.800 → 3.000" y al lado "+0.139".
  const delta =
    proyectado !== null && data.summary.gpa !== null ? roundGpa(proyectado) - roundGpa(data.summary.gpa) : 0;
  const algunaNota = Object.values(hipo).some(Boolean);

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {/* flex-wrap y una base para el chip: el chip, los créditos y los cinco
            botones de nota no entran en una línea de 390px, y sin envolver
            empujaban la página entera a lo ancho. */}
        {enCurso.map((c) => (
          <li key={c.code} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div className="min-w-0 flex-1 basis-48">
              <CourseChip code={c.code} title={c.title ?? c.code} size="sm" />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-muted tabular text-xs">{c.units ?? 0} cr</span>
              <div className="border-line flex rounded-[var(--radius)] border p-0.5" role="group" aria-label={`Nota hipotética de ${c.code}`}>
                {Object.keys(GRADE_POINTS).map((g) => (
                  <button
                    key={g}
                    type="button"
                    aria-pressed={hipo[c.code] === g}
                    onClick={() => setHipo((h) => ({ ...h, [c.code]: h[c.code] === g ? '' : g }))}
                    className={`min-h-8 w-7 rounded-[4px] font-mono text-xs transition-colors duration-100 ${
                      hipo[c.code] === g ? 'bg-accent text-accent-fg font-medium' : 'text-muted hover:text-fg'
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>
          </li>
        ))}
      </ul>

      <div className="border-line flex items-baseline justify-between gap-3 border-t pt-3">
        <div>
          <div className="text-muted text-xs tracking-wide uppercase">Índice proyectado</div>
          <div className="text-muted mt-0.5 text-xs">
            {algunaNota ? `sobre ${creditos} créditos` : 'elegí notas hipotéticas para proyectar'}
          </div>
        </div>
        <div className="text-right">
          <div className="font-display tabular text-3xl font-semibold tracking-tight">{formatGpa(proyectado)}</div>
          {/* Un cambio que no mueve el índice oficial no se anuncia como que lo
              movió: a este decimal, o cambia o no cambia. */}
          {algunaNota && Math.abs(delta) >= 0.05 && (
            <div className={`tabular text-xs ${delta > 0 ? 'text-open' : 'text-closed'}`}>
              {delta > 0 ? '+' : '−'}
              {Math.abs(delta).toFixed(3)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Metas y señales (Fase 10, §12.7) ─────────────────────────────────────────

// El veredicto de una meta en palabras de herramienta (copy aprobado §13.2). El
// "fuera de alcance" solo se emite porque la política de repetición está
// verificada: no hay un truco de repetir que lo salve.
function veredicto(g: GoalEvaluation): { label: string; tone: string; detail: string | null } {
  const avg = g.requiredAverage;
  switch (g.verdict) {
    case 'met':
      return { label: 'Ya la alcanzaste', tone: 'text-open', detail: null };
    case 'secured':
      return { label: 'Asegurada', tone: 'text-open', detail: 'llegás aunque saques F en lo que falta' };
    case 'reachable':
      return { label: 'Alcanzable', tone: 'text-open', detail: avg ? `necesitás promedio ${avg.toFixed(1)} en lo que falta` : null };
    case 'tight':
      return { label: 'Al límite', tone: 'text-waitlist', detail: avg ? `exige casi todo A (${avg.toFixed(1)})` : null };
    case 'unreachable':
      return {
        label: 'Fuera de alcance',
        tone: 'text-closed',
        detail: avg && avg > 4 ? 'ni con todo A en lo que falta' : 'con lo que falta ya no se alcanza',
      };
  }
}

// Los dos horizontes de P5. Separados a propósito: sumar los créditos en curso
// de este ciclo con los que faltan hasta graduarte producía un "mejor caso" que
// no correspondía a ningún momento real de la carrera.
//
// Y si el acumulado reconstruido no cuadra con el que publica PeopleSoft, acá
// no hay número que esconder: el backend devuelve los horizontes en null y esta
// pantalla explica la diferencia en su lugar.
function Horizontes({ report }: { report?: ProjectionReport }) {
  const [comoSeCalcula, setComoSeCalcula] = useState(false);
  if (!report) return null;

  const { reconciliation: rec } = report;

  if (rec.status !== 'match') {
    return (
      <section
        className={`rounded-[var(--radius)] border p-3 text-sm ${
          rec.status === 'mismatch' ? 'border-closed/40 bg-closed/5' : 'border-line'
        }`}
      >
        <h3 className="text-sm font-medium">
          {rec.status === 'mismatch' ? 'No podemos proyectar con confianza' : 'Todavía no podemos proyectar'}
        </h3>
        <p className="text-muted mt-1 text-xs">{rec.explanation}</p>
        {rec.difference !== null && (
          <p className="text-muted tabular mt-2 font-mono text-xs">
            PeopleSoft {rec.official?.toFixed(3)} · mikampus {rec.reconstructed?.toFixed(3)} · diferencia{' '}
            {rec.difference.toFixed(3)}
          </p>
        )}
      </section>
    );
  }

  return (
    <div className="space-y-4">
      {[report.currentTerm, report.graduation].map((scenarios, index) =>
        scenarios ? (
          <section key={scenarios.best.id}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-display text-sm font-semibold tracking-tight">{scenarios.best.label}</h3>
              <span className="text-muted tabular text-xs">
                sobre {scenarios.best.futureCredits} crédito(s){index === 0 ? ' en curso' : ' pendientes'}
              </span>
            </div>
            {scenarios.best.futureCredits === 0 ? (
              <p className="text-muted mt-1 text-xs">
                {index === 0
                  ? 'No tenés materias en curso en este ciclo, así que tu índice no se mueve al cerrarlo.'
                  : 'El advisement no reporta créditos pendientes.'}
              </p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-x-8 gap-y-3">
                <FanNumber label="Mejor caso" value={scenarios.best.exact?.toFixed(2) ?? '—'} tone="text-open" />
                <FanNumber label="Si mantenés tu ritmo" value={scenarios.maintain.exact?.toFixed(2) ?? '—'} />
                <FanNumber label="Piso (todo C)" value={scenarios.floor.exact?.toFixed(2) ?? '—'} />
              </div>
            )}
            {/* Escenario, no promesa. El plan es explícito en que la palabra
                importa: nadie puede garantizar una nota futura. */}
            <p className="text-muted mt-1.5 text-xs">
              Son escenarios, no promesas. PeopleSoft lo publicaría como{' '}
              <span className="tabular font-mono">{scenarios.best.asPublished?.toFixed(3) ?? '—'}</span> en el mejor caso.
            </p>
          </section>
        ) : null
      )}

      <div>
        <button
          type="button"
          onClick={() => setComoSeCalcula((open) => !open)}
          aria-expanded={comoSeCalcula}
          className="text-muted hover:text-fg text-xs underline underline-offset-2"
        >
          Cómo se calcula
        </button>
        {comoSeCalcula && (
          <div className="border-line text-muted mt-2 space-y-1.5 rounded-[var(--radius)] border p-3 text-xs">
            <p className="font-mono">{report.formula}</p>
            <p>
              El índice de partida es el que publica PeopleSoft ({rec.official?.toFixed(3)}), no el nuestro. Nuestro
              cálculo por materias ({rec.reconstructed?.toFixed(3)}) queda como auditoría y se compara en cada sync.
            </p>
            <p>
              «Mejor caso» asume 4.0 en lo que falta, «mantener» asume tu propio promedio y «piso» asume 2.0. El
              resultado se muestra a dos decimales; el portal publica con uno.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function FanNumber({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-muted text-xs tracking-wide uppercase">{label}</div>
      <div className={`font-display tabular text-2xl font-semibold tracking-tight ${tone ?? ''}`}>{value}</div>
    </div>
  );
}

function Metas() {
  const qc = useQueryClient();
  const goals = useQuery({ queryKey: ['goals'], queryFn: fetchGoals });
  const [target, setTarget] = useState('3.0');

  const onData = (fresh: GoalsResponse) => qc.setQueryData(['goals'], fresh);
  const create = useMutation({ mutationFn: () => createGoal({ target: Number(target) }), onSuccess: onData });
  const remove = useMutation({ mutationFn: (id: number) => deleteGoal(id), onSuccess: onData });

  const data = goals.data;

  return (
    <div className="space-y-4">
      {/* El abanico honesto: dónde puede terminar tu índice según lo que saques
          en lo que falta del pénsum. */}
      <Horizontes report={data?.horizons} />

      {/* Las metas fijadas, con su veredicto en vivo. */}
      {!!data?.goals.length && (
        <ul className="border-line divide-line divide-y rounded-[var(--radius)] border">
          {data.goals.map((g) => {
            const v = veredicto(g);
            return (
              <li key={g.id} className="flex min-h-11 items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="font-display tabular text-lg font-semibold">{g.target.toFixed(1)}</span>
                    <span className={`text-xs font-medium ${v.tone}`}>{v.label}</span>
                  </div>
                  {v.detail && <div className="text-muted text-xs">{v.detail}</div>}
                </div>
                <button
                  type="button"
                  onClick={() => remove.mutate(g.id)}
                  className="text-muted hover:text-closed min-h-8 shrink-0 text-xs"
                  aria-label={`Quitar meta de ${g.target.toFixed(1)}`}
                >
                  Quitar
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Fijar una meta nueva. La escala es 0–4; el backend la valida igual. */}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label className="text-muted text-xs">Fijar meta de índice</label>
        <input
          type="number"
          min="0.1"
          max="4"
          step="0.1"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="border-line tabular w-16 rounded-[var(--radius)] border px-2 py-1 text-sm font-mono"
          aria-label="Índice objetivo"
        />
        <button
          type="submit"
          disabled={create.isPending}
          className="bg-accent text-accent-fg min-h-8 rounded-[var(--radius)] px-3 py-1 text-xs font-medium disabled:opacity-50"
        >
          Fijar
        </button>
        {create.error && <span className="text-closed text-xs">{create.error.message}</span>}
      </form>
    </div>
  );
}

// El grado como flecha de intentos: "F → D". El color no se toca — es texto.
function attemptTrail(attempts: { grade: string | null }[]): string {
  return attempts.map((a) => a.grade ?? '—').join(' → ');
}

function SenalCard({ insight, destacada = false }: { insight: Insight; destacada?: boolean }) {
  let title = '';
  let body: ReactNode = null;

  switch (insight.kind) {
    // El cambio reciente es lo que la persona SIENTE: cómo le fue el último
    // ciclo comparado con el anterior. Antes lo tapaba la tendencia de tres.
    case 'recent-change': {
      const neto = insight.delta > 0 ? `+${insight.delta.toFixed(1)}` : insight.delta.toFixed(1);
      title =
        insight.direction === 'down'
          ? 'Tu último ciclo bajó'
          : insight.direction === 'up'
            ? 'Tu último ciclo subió'
            : 'Tu último ciclo se mantuvo';
      body = (
        <>
          {insight.from.term} <span className="tabular font-mono">{insight.from.gpa.toFixed(1)}</span> → {insight.to.term}{' '}
          <span className="tabular font-mono">{insight.to.gpa.toFixed(1)}</span>
          {insight.direction !== 'flat' && <span className="text-muted"> · {neto}</span>}
        </>
      );
      break;
    }
    case 'rolling-trend': {
      const seq = insight.points.map((p) => p.gpa.toFixed(1)).join(' → ');
      const neto = insight.delta > 0 ? `+${insight.delta.toFixed(1)}` : insight.delta.toFixed(1);
      title = 'Tendencia de los últimos 3 ciclos';
      body = (
        <>
          <span className="tabular font-mono">{seq}</span>
          {insight.direction !== 'flat' && <span className="text-muted"> · {neto} neto</span>}
        </>
      );
      break;
    }
    case 'area-performance':
      title = 'Rendís distinto según el área';
      body = (
        <>
          Mejor: <span className="font-medium">{insight.best.subject}</span>{' '}
          <span className="tabular font-mono">{insight.best.gpa.toFixed(1)}</span> ({insight.best.count} materias). Más
          baja: <span className="font-medium">{insight.worst.subject}</span>{' '}
          <span className="tabular font-mono">{insight.worst.gpa.toFixed(1)}</span> ({insight.worst.count}).
        </>
      );
      break;
    case 'load-vs-result':
      title = 'Carga vs. resultado';
      body = (
        <>
          Tus ciclos más cargados (~{insight.heavy.avgCredits} cr) promedian{' '}
          <span className="tabular font-mono">{insight.heavy.avgGpa.toFixed(1)}</span>; los más livianos (~
          {insight.light.avgCredits} cr), <span className="tabular font-mono">{insight.light.avgGpa.toFixed(1)}</span>.
        </>
      );
      break;
    case 'repeated-courses':
      title = 'Materias repetidas';
      body = (
        <>
          {insight.courses.map((c, i) => (
            <span key={c.code}>
              {i > 0 && ', '}
              {c.code} ({attemptTrail(c.attempts)})
            </span>
          ))}
          . En PUCMM ambos intentos cuentan al índice: repetir no borra la nota vieja.
        </>
      );
      break;
    case 'withdrawn-courses':
      title = 'Materias retiradas (R)';
      body = (
        <>
          {insight.count}: no bajan el índice, pero son créditos cursados sin avanzar — {insight.codes.join(', ')}.
        </>
      );
      break;
  }

  // El color de alarma se gana: solo una señal marcada como riesgo real lo
  // recibe. Pintar de rojo un patrón histórico entrena a ignorar el rojo.
  const tono =
    insight.severity === 'risk'
      ? 'border-closed/40 bg-closed/5'
      : insight.severity === 'watch' && destacada
        ? 'border-waitlist/40 bg-waitlist/5'
        : 'border-line';

  return (
    <div className={`rounded-[var(--radius)] border p-3 ${tono}`}>
      <div className="text-muted mb-1 text-xs font-medium tracking-wide uppercase">{title}</div>
      <div className={destacada ? 'text-base' : 'text-sm'}>{body}</div>
    </div>
  );
}

function Senales() {
  const insights = useQuery({ queryKey: ['insights'], queryFn: fetchInsights });
  if (insights.isPending || insights.error) return null;
  const list = insights.data?.insights ?? [];
  if (!list.length) {
    return <p className="text-muted text-sm">Todavía no hay suficientes datos para señales.</p>;
  }
  // El backend ya las devuelve ordenadas por prioridad real (severidad,
  // actualidad, posibilidad de acción). Acá solo se corta: la primera se lleva
  // el ancho completo bajo "Lo más importante" y el resto baja a contexto.
  // Una lista pareja hacía que una caída de este ciclo y un patrón de hace tres
  // años se vieran igual de urgentes.
  const [principal, ...contexto] = list;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-muted mb-2 text-xs font-medium tracking-wide uppercase">Lo más importante</h3>
        <SenalCard insight={principal} destacada />
      </div>
      {contexto.length > 0 && (
        <div>
          <h3 className="text-muted mb-2 text-xs font-medium tracking-wide uppercase">Contexto</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {contexto.map((s, i) => (
              <SenalCard key={`${s.kind}-${i}`} insight={s} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TablaTermino({ term }: { term: TermGrades }) {
  return (
    <section>
      <header className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="font-display text-base font-semibold tracking-tight">{term.term}</h3>
        <div className="text-muted tabular text-xs">
          {term.gpa !== null ? `índice ${formatGpa(term.gpa)}` : 'en curso'}
          {term.unitsTowardGpa > 0 && ` · ${term.unitsTowardGpa} cr`}
        </div>
      </header>
      <ul className="border-line divide-line divide-y rounded-[var(--radius)] border">
        {term.courses.map((c) => (
          <li key={c.code} className="flex min-h-11 items-center justify-between gap-3 px-3 py-2">
            <CourseChip code={c.code} title={c.title ?? c.code} size="sm" />
            <div className="flex shrink-0 items-center gap-3">
              <span className="text-muted tabular text-xs">{c.units ?? 0} cr</span>
              <span className="tabular w-8 text-right font-mono text-lg font-medium">
                {c.grade ?? <span className="text-muted text-xs">—</span>}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Notas({ data }: { data: GradesResponse }) {
  const [term, setTerm] = useState<string>('todos');
  const visibles = term === 'todos' ? data.terms : data.terms.filter((t) => t.term === term);

  return (
    <div className="space-y-5">
      {/* items-start: alineados por la etiqueta de arriba. Con items-end, la
          tarjeta sin línea de detalle empuja su número hacia abajo y la fila
          se lee como rota. */}
      <div className="border-line grid gap-x-8 gap-y-5 rounded-[var(--radius)] border p-4 sm:grid-cols-[repeat(3,auto)_1fr] sm:items-start">
        <BigNumber
          label="Índice acumulado"
          value={formatGpa(data.summary.gpa)}
          hint={`${data.summary.gradePoints} pts / ${data.summary.unitsTowardGpa} cr`}
        />
        <BigNumber label="Créditos aprobados" value={String(data.summary.unitsPassed)} hint="que cuentan al índice" />
        <BigNumber label="En curso" value={String(data.summary.unitsInProgress)} hint="créditos sin calificar" />
      </div>

      {/* La trayectoria se gana su propia sección: era un sparkline de 132×34
          metido en una esquina, y es la única gráfica de la app. */}
      <TrajectoryChart terms={data.terms} />

      <section className="border-line rounded-[var(--radius)] border p-4">
        <h2 className="font-display mb-3 text-base font-semibold tracking-tight">Simulador</h2>
        <WhatIf data={data} />
      </section>

      <section className="border-line rounded-[var(--radius)] border p-4">
        <h2 className="font-display mb-3 text-base font-semibold tracking-tight">Metas</h2>
        <Metas />
      </section>

      <section className="border-line rounded-[var(--radius)] border p-4">
        <h2 className="font-display mb-3 text-base font-semibold tracking-tight">Señales</h2>
        <Senales />
      </section>

      <div className="flex flex-wrap items-center gap-2">
        {(['todos', ...data.terms.map((t) => t.term)] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTerm(t)}
            aria-pressed={term === t}
            className={`min-h-8 rounded-full px-3 py-1 text-xs transition-colors duration-100 ${
              term === t ? 'bg-accent text-accent-fg font-medium' : 'border-line text-muted hover:text-fg border'
            }`}
          >
            {t === 'todos' ? 'Todos los términos' : t}
          </button>
        ))}
      </div>

      <div className="space-y-5">
        {visibles.map((t) => (
          <TablaTermino key={t.term} term={t} />
        ))}
      </div>
    </div>
  );
}

const ESTADO_LABEL: Record<string, string> = {
  taken: 'Aprobada',
  in_progress: 'En curso',
  planned: 'Planificada',
  pending: 'Pendiente',
};

// El puntito de color a la izquierda de cada materia: dice su estado de un
// vistazo con el mismo lenguaje de color de los cupos (verde aprobada, azul en
// curso, hueco pendiente).
function EstadoDot({ item }: { item: RequirementItem }) {
  const cls =
    item.status === 'taken'
      ? 'bg-open'
      : item.status === 'in_progress'
        ? 'bg-accent'
        : item.offered
          ? 'bg-open/40'
          : 'border-line border bg-transparent';
  return <span className={`inline-block size-2 shrink-0 rounded-full ${cls}`} aria-hidden />;
}

function MateriaFila({ item }: { item: RequirementItem }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <EstadoDot item={item} />
        <CourseChip code={item.code} title={item.title ?? item.code} size="sm" />
      </div>
      <span className="text-muted flex shrink-0 items-center gap-1.5 text-xs">
        {item.grade ? (
          <span className="tabular font-mono">{item.grade}</span>
        ) : item.status === 'pending' && item.offered ? (
          <span className="text-open">se oferta</span>
        ) : (
          <span>{ESTADO_LABEL[item.status] ?? item.status}</span>
        )}
      </span>
    </div>
  );
}

// El nombre humano de una electiva sin el prefijo de código: "ICC-E01-T
// Electiva de Inteligencia Artificial" → "Electiva de Inteligencia Artificial".
function nombreElectiva(label: string): string {
  const m = label.match(/(Electiva.*)$/i);
  return m ? m[1] : label;
}

// Un slot de electiva: elegís 1 de N. Satisfecho = ya elegiste (el portal
// oculta las candidatas, y las respetamos: no las hay). Pendiente = se listan
// las candidatas, plegadas para no inflar la vista.
function ElectivaSlot({ group }: { group: RequirementGroup }) {
  return (
    <div className="border-line rounded-[var(--radius)] border border-dashed p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm">{nombreElectiva(group.label)}</span>
        {group.satisfied ? (
          <span className="text-open flex shrink-0 items-center gap-1 text-xs"><Check className="size-3.5" aria-hidden />satisfecha</span>
        ) : (
          <span className="text-muted tabular shrink-0 text-xs">elegí 1 · {group.items.length} opciones</span>
        )}
      </div>
      {!group.satisfied && group.items.length > 0 && (
        <details className="mt-1.5">
          <summary className="text-muted hover:text-fg cursor-pointer text-xs">Ver candidatas</summary>
          <div className="mt-1.5 space-y-1">
            {group.items.map((it) => (
              <MateriaFila key={it.code} item={it} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function PeriodoCard({ periodo }: { periodo: RequirementGroup }) {
  const obligatorios = periodo.children.find((g) => g.kind === 'obligatorios');
  const electivas = periodo.children.filter((g) => g.kind === 'electiva');
  const cr = periodo.units;

  return (
    <article
      className={`space-y-2 rounded-[var(--radius)] border p-3 ${
        periodo.satisfied ? 'border-line bg-surface-2' : 'border-line'
      }`}
    >
      <header className="flex items-baseline justify-between gap-2">
        <h4 className="font-display text-sm font-semibold tracking-tight">Período {periodo.period}</h4>
        {periodo.satisfied ? (
          <span className="text-open flex items-center gap-1 text-xs font-medium"><Check className="size-3.5" aria-hidden />completo</span>
        ) : (
          <span className="text-muted tabular text-xs">
            {cr.taken ?? 0}/{cr.required ?? 0} cr
          </span>
        )}
      </header>

      {obligatorios && obligatorios.items.length > 0 && (
        <div className="divide-line divide-y">
          {obligatorios.items.map((it) => (
            <MateriaFila key={it.code} item={it} />
          ))}
        </div>
      )}

      {electivas.map((e) => (
        <ElectivaSlot key={e.id} group={e} />
      ))}

      {/* Un período satisfecho viene colapsado en el informe: sus materias no
          están en el DOM. No mentimos con una lista vacía; el estado ya lo dice. */}
      {periodo.satisfied && !obligatorios && electivas.length === 0 && (
        <p className="text-muted text-xs">Período aprobado.</p>
      )}
    </article>
  );
}

function Avance({ data }: { data: RequirementsResponse }) {
  const [soloFalta, setSoloFalta] = useState(false);
  const root = data.tree;

  const porAnio = useMemo(() => {
    if (!root) return [];
    const periodos = root.children.filter((g) => g.kind === 'periodo');
    const visibles = soloFalta ? periodos.filter((p) => !p.satisfied) : periodos;
    const m = new Map<number, RequirementGroup[]>();
    for (const p of visibles) {
      const y = p.year ?? 0;
      if (!m.has(y)) m.set(y, []);
      m.get(y)!.push(p);
    }
    for (const list of m.values()) list.sort((a, b) => (a.period ?? 0) - (b.period ?? 0));
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [root, soloFalta]);

  if (!root) {
    return <p className="text-muted text-sm">El árbol de requisitos aparece cuando sincronices el avance.</p>;
  }

  const cr = root.units;
  const materias = root.courses;

  return (
    <div className="space-y-5">
      <div className="border-line flex flex-wrap items-center justify-between gap-4 rounded-[var(--radius)] border p-4">
        <div className="flex flex-wrap gap-6">
          <BigNumber
            label="Créditos"
            value={`${cr.taken ?? 0}/${cr.required ?? 0}`}
            hint={cr.needed ? `${cr.needed} faltantes` : 'completo'}
          />
          <BigNumber label="Materias faltantes" value={String(materias.needed ?? 0)} />
          {data.profile?.pensum_no && (
            <BigNumber label="Pénsum" value={data.profile.pensum_no} hint={data.profile.career ?? undefined} />
          )}
        </div>
        <button
          type="button"
          onClick={() => setSoloFalta((v) => !v)}
          aria-pressed={soloFalta}
          className={`min-h-8 rounded-full px-3 py-1 text-xs transition-colors duration-100 ${
            soloFalta ? 'bg-accent text-accent-fg font-medium' : 'border-line text-muted hover:text-fg border'
          }`}
        >
          Solo lo que me falta
        </button>
      </div>

      {/* Honestidad de estado: la app no puede decir "elegible" porque el
          portal no publica prerequisitos en ninguna parte. */}
      <p className="text-muted text-xs">
        "Se oferta" significa que la materia tiene grupos publicados este término, no que cumplas sus requisitos: el
        portal no publica los prerequisitos.
      </p>

      <div className="space-y-6">
        {porAnio.map(([anio, periodos]) => (
          <section key={anio}>
            <h3 className="text-muted mb-2 text-xs font-medium tracking-wide uppercase">Año {anio}</h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {periodos.map((p) => (
                <PeriodoCard key={p.id} periodo={p} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export function Academico() {
  const [tab, setTab] = useState<'notas' | 'avance'>('notas');
  const queryClient = useQueryClient();

  const grades = useQuery({ queryKey: ['grades'], queryFn: fetchGrades });
  const requirements = useQuery({ queryKey: ['requirements'], queryFn: () => fetchRequirements() });

  const syncG = useMutation({
    mutationFn: syncGrades,
    onSuccess: (fresh) => queryClient.setQueryData(['grades'], fresh),
  });
  const syncP = useMutation({
    mutationFn: syncPensum,
    // El sync reconstruye el árbol Y deriva el pénsum plano: refrescar ambos.
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['requirements'] });
      queryClient.invalidateQueries({ queryKey: ['pensum'] });
    },
  });

  const activa = tab === 'notas' ? grades : requirements;
  const sync = tab === 'notas' ? syncG : syncP;
  const vacio = tab === 'notas' ? !grades.data?.terms.length : !requirements.data?.tree;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Notas y avance</h1>
        <div className="flex items-center gap-3">
          <StalenessTag at={activa.data?.syncedAt ?? null} onRefresh={() => sync.mutate()} refreshing={sync.isPending} />
          <div className="border-line flex rounded-[var(--radius)] border p-0.5" role="group" aria-label="Sección">
            {(['notas', 'avance'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                aria-pressed={tab === t}
                className={`min-h-8 rounded-[4px] px-2.5 py-1 text-xs transition-colors duration-100 ${
                  tab === t ? 'bg-accent text-accent-fg font-medium' : 'text-muted hover:text-fg'
                }`}
              >
                {t === 'notas' ? 'Notas' : 'Avance'}
              </button>
            ))}
          </div>
        </div>
      </header>

      {sync.error && (
        <p className="text-closed text-sm">PeopleSoft no respondió ({sync.error.message}). Reintentar con "refrescar".</p>
      )}

      {activa.isPending ? (
        <div className="border-line text-muted grid h-96 place-items-center rounded-[var(--radius)] border text-sm">Cargando…</div>
      ) : activa.error ? (
        <p className="text-closed text-sm">No se pudo leer lo guardado: {activa.error.message}</p>
      ) : vacio ? (
        <div className="border-line rounded-[var(--radius)] border border-dashed p-8 text-center">
          <p className="text-sm">
            {tab === 'notas' ? 'Todavía no hay notas guardadas.' : 'Todavía no hay pénsum guardado.'}
          </p>
          <button
            type="button"
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
            className="bg-accent text-accent-fg mt-3 rounded-[var(--radius)] px-3 py-2 text-sm font-medium disabled:opacity-50"
          >
            {sync.isPending ? 'Leyendo PeopleSoft…' : 'Traerlo de PeopleSoft'}
          </button>
        </div>
      ) : tab === 'notas' ? (
        <Notas data={grades.data!} />
      ) : (
        <Avance data={requirements.data!} />
      )}
    </div>
  );
}
