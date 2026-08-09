import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchRequirements,
  fetchGrades,
  fetchTermContext,
  fetchMySchedule,
  fetchPlans,
  fetchCart,
  syncPensum,
} from '../lib/api.ts';
import { CourseChip } from '../components/CourseChip.tsx';
import { TermBadge } from '../components/TermBadge.tsx';
import { StalenessTag } from '../components/StalenessTag.tsx';
import { formatGpa } from '../../../src/shared/gpa.ts';
import { careerSummary, futureBlocks, type CareerSummary, type FutureBlock } from '../../../src/shared/trajectory.ts';
import type { TermGrades } from '../../../src/shared/schemas.ts';

// Trayectoria (plan §12.3, zona "Mi carrera"): la carrera como una línea de
// tiempo vertical, un nodo por término. Pasado (materias + nota + índice),
// presente (en curso), próximo ciclo (lo que vas a inscribir) y futuro (los
// bloques del pénsum sin cerrar). Arriba, dónde estás parado y el atraso —
// medido contra el pénsum, con su base de cálculo visible, nunca una vibra.
// Todo es cálculo local: no hay scraping nuevo, solo cruzar lo que ya tenemos.

// El punto de color de cada nodo dice de un vistazo en qué tiempo está: cerrado
// (verde), en curso (azul), lo que viene (azul hueco), lo que falta (hueco).
type Tono = 'pasado' | 'presente' | 'proximo' | 'futuro';

function Nodo({ tono, children, ultimo }: { tono: Tono; children: ReactNode; ultimo?: boolean }) {
  const dot =
    tono === 'pasado'
      ? 'bg-open'
      : tono === 'presente'
        ? 'bg-accent'
        : tono === 'proximo'
          ? 'bg-accent/40 border-accent border'
          : 'border-line bg-surface border';
  return (
    <li className="relative pb-6 pl-8 last:pb-0">
      {/* La línea que une los nodos. El último no la lleva: no hay nada abajo. */}
      {!ultimo && <span className="bg-line absolute top-2 bottom-0 left-[5px] w-px" aria-hidden />}
      <span className={`absolute top-1 left-0 size-3 rounded-full ${dot}`} aria-hidden />
      {children}
    </li>
  );
}

// El encabezado: la posición en la carrera y el atraso, con su base de cálculo a
// la vista. El atraso es una inferencia (cohorte + 3 ciclos/año); se dice.
function Posicion({ summary }: { summary: CareerSummary }) {
  const { position: p, credits: c, delay: d } = summary;
  return (
    <div className="border-line space-y-3 rounded-[var(--radius)] border p-4">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <div className="text-muted text-xs tracking-wide uppercase">Estás en</div>
          <div className="font-display text-2xl font-semibold tracking-tight">
            {p.done ? (
              'Carrera completa'
            ) : (
              <>
                Año {p.year} Período {p.period}{' '}
                <span className="text-muted tabular text-lg font-normal">de {p.total}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Cifra label="Créditos" value={`${c.taken ?? 0}/${c.required ?? 0}`} hint={c.needed ? `${c.needed} faltan` : 'completo'} />
          <Cifra label="Materias" value={String(summary.coursesNeeded ?? 0)} hint="faltantes" />
          <Cifra
            label="Ciclos"
            value={summary.cyclesLeft === 0 ? '—' : `~${summary.cyclesLeft}`}
            hint={summary.cyclesLeft === 0 ? 'terminaste' : 'para terminar'}
          />
        </div>
      </div>

      {/* El atraso, con su base: ciclos cursados desde la cohorte vs. bloques
          cerrados, y el hecho concreto —el bloque más viejo sin cerrar. */}
      {d.oldest && d.elapsedCycles !== null && (
        <div className="border-line border-t pt-3">
          <p className="text-sm">
            Llevás <span className="tabular font-medium">{d.elapsedCycles}</span> ciclos cursando desde{' '}
            {d.cohortLabel ?? 'tu cohorte'} y cerraste{' '}
            <span className="tabular font-medium">{d.satisfiedPeriods}</span> de {d.totalPeriods} bloques.
            {d.behindCycles && d.behindCycles > 0 ? (
              <>
                {' '}Tu bloque más viejo sin cerrar es{' '}
                <span className="font-medium">
                  Año {d.oldest.year} Período {d.oldest.period}
                </span>{' '}
                — te {d.oldest.pendingCount === 1 ? 'falta' : 'faltan'}{' '}
                <span className="tabular font-medium">{d.oldest.pendingCount}</span>{' '}
                {d.oldest.pendingCount === 1 ? 'materia' : 'materias'} obligatoria
                {d.oldest.pendingCount === 1 ? '' : 's'}, unos{' '}
                <span className="text-closed tabular font-medium">{d.behindCycles}</span> ciclos de atraso.
              </>
            ) : (
              ' Vas al día con el ritmo del pénsum.'
            )}
          </p>
          <p className="text-muted mt-1 text-xs">
            El atraso es una estimación contra el ritmo nominal (un período por ciclo). La cohorte se ajusta en Ajustes.
          </p>
        </div>
      )}
    </div>
  );
}

function Cifra({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-muted text-xs tracking-wide uppercase">{label}</div>
      <div className="font-display tabular text-xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="text-muted tabular text-xs">{hint}</div>}
    </div>
  );
}

// Un término del pasado o el presente: su índice y créditos siempre a la vista;
// las materias, plegadas para que la línea de tiempo se lea de un vistazo.
function TerminoNodo({ term, presente, ultimo }: { term: TermGrades; presente: boolean; ultimo?: boolean }) {
  return (
    <Nodo tono={presente ? 'presente' : 'pasado'} ultimo={ultimo}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex items-baseline gap-2">
          <h3 className="font-display text-base font-semibold tracking-tight">{term.term}</h3>
          {presente && <span className="text-accent text-xs font-medium">en curso</span>}
        </div>
        <div className="text-muted tabular text-xs">
          {term.gpa !== null ? `índice ${formatGpa(term.gpa)}` : 'sin índice todavía'}
          {term.unitsTowardGpa > 0 && ` · ${term.unitsTowardGpa} cr`}
        </div>
      </div>
      <details className="mt-1.5">
        <summary className="text-muted hover:text-fg cursor-pointer text-xs">
          {term.courses.length} {term.courses.length === 1 ? 'materia' : 'materias'}
        </summary>
        <ul className="mt-2 space-y-1.5">
          {term.courses.map((c) => (
            <li key={c.code} className="flex min-h-8 items-center justify-between gap-2">
              <CourseChip code={c.code} title={c.title ?? c.code} size="sm" />
              <span className="tabular w-7 shrink-0 text-right font-mono text-sm">
                {c.grade ?? <span className="text-muted text-xs">—</span>}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </Nodo>
  );
}

// El puente al próximo ciclo: lo que vas a inscribir, en orden de compromiso
// (inscrito > carrito > plan). Enlaza a las pantallas donde se actúa.
function ProximoNodo({
  label,
  enrolled,
  cartCount,
  planes,
  ultimo,
}: {
  label: string | null;
  enrolled: number;
  cartCount: number;
  planes: number;
  ultimo?: boolean;
}) {
  const estado =
    enrolled > 0
      ? `${enrolled} ${enrolled === 1 ? 'materia inscrita' : 'materias inscritas'}`
      : cartCount > 0
        ? `${cartCount} en el carrito`
        : planes > 0
          ? `${planes} ${planes === 1 ? 'plan armado' : 'planes armados'}`
          : 'sin materias todavía';
  const destino = enrolled > 0 || cartCount > 0 ? '/inscripcion' : '/inscripcion?etapa=plan';

  return (
    <Nodo tono="proximo" ultimo={ultimo}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex items-baseline gap-2">
          <h3 className="font-display text-base font-semibold tracking-tight">Próximo ciclo</h3>
          <TermBadge label={label} />
        </div>
        <span className="text-accent text-xs font-medium">a inscribir</span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-3">
        <span className="text-sm">{estado}</span>
        <Link to={destino} className="text-accent shrink-0 text-xs font-medium hover:underline">
          {enrolled > 0 || cartCount > 0 ? 'Ir a inscripción →' : planes > 0 ? 'Seguir planeando →' : 'Planear mi ciclo →'}
        </Link>
      </div>
    </Nodo>
  );
}

// Un bloque futuro: un período del pénsum sin cerrar. Las obligatorias que
// faltan y los slots de electiva sin elegir, honestamente como lo que son —
// deuda del pénsum, no "elegible" (el portal no publica prerequisitos).
function FuturoNodo({ block, ultimo }: { block: FutureBlock; ultimo?: boolean }) {
  return (
    <Nodo tono="futuro" ultimo={ultimo}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="font-display text-muted text-base font-medium tracking-tight">
          Año {block.year} Período {block.period}
        </h3>
        {block.creditsNeeded ? <span className="text-muted tabular text-xs">{block.creditsNeeded} cr faltan</span> : null}
      </div>
      {block.pending.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {block.pending.map((it) => (
            <li key={it.code}>
              <CourseChip code={it.code} title={it.title ?? it.code} size="sm" />
            </li>
          ))}
        </ul>
      )}
      {block.electives.map((e, i) => (
        <div key={i} className="text-muted mt-1.5 text-xs">
          {e.label} · elegí 1 {e.options > 0 ? `de ${e.options}` : ''}
        </div>
      ))}
    </Nodo>
  );
}

export function Trayectoria() {
  const queryClient = useQueryClient();
  const requirements = useQuery({ queryKey: ['requirements'], queryFn: () => fetchRequirements() });
  const grades = useQuery({ queryKey: ['grades'], queryFn: fetchGrades });
  const terms = useQuery({ queryKey: ['term-context'], queryFn: fetchTermContext });
  const plans = useQuery({ queryKey: ['plans'], queryFn: fetchPlans });
  const cart = useQuery({ queryKey: ['cart'], queryFn: fetchCart });

  const current = terms.data?.current ?? null;
  const next = terms.data?.next ?? null;
  const nextSchedule = useQuery({
    queryKey: ['my-schedule', next?.code],
    queryFn: () => fetchMySchedule(next!.code!),
    enabled: !!next?.code,
  });

  const sync = useMutation({
    mutationFn: syncPensum,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['requirements'] });
      queryClient.invalidateQueries({ queryKey: ['pensum'] });
    },
  });

  const tree = requirements.data?.tree ?? null;
  const profile = requirements.data?.profile ?? null;

  const summary = useMemo(
    () =>
      tree
        ? careerSummary(tree, {
            cohortStartTerm: profile?.cohort_start_term ?? null,
            currentTermLabel: current?.label ?? null,
          })
        : null,
    [tree, profile, current]
  );
  const future = useMemo(() => (tree ? futureBlocks(tree) : []), [tree]);

  // Los términos con notas hasta el ciclo actual inclusive, del más viejo al más
  // nuevo: así fluye la línea de tiempo hacia abajo. El "presente" es el término
  // que corre hoy. Un término del histórico posterior al actual (una materia
  // pre-inscrita para el ciclo que viene, como ICC-233 en Septiembre) NO va acá:
  // es futuro y lo cuenta el nodo "Próximo ciclo". Mezclarlos sería el bug que
  // el §11 prohíbe — un ciclo futuro pintado como pasado.
  const pastTerms = useMemo(() => {
    const currentKey = current?.sortKey ?? null;
    const list = (grades.data?.terms ?? [])
      .filter((t) => t.sortKey)
      .filter((t) => (currentKey ? t.sortKey! <= currentKey : true));
    return [...list].sort((a, b) => a.sortKey!.localeCompare(b.sortKey!));
  }, [grades.data, current]);

  const nextEnrolled = (nextSchedule.data?.courses ?? []).filter((c) => c.status === 'enrolled').length;
  const nextPlans = (plans.data ?? []).filter((p) => next && p.term === next.code).length;

  const cargando = requirements.isPending || grades.isPending || terms.isPending;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <h1 className="font-display text-2xl font-semibold tracking-tight">Trayectoria</h1>
          {profile?.career && <span className="text-muted text-sm">{profile.career}</span>}
        </div>
        <StalenessTag
          at={requirements.data?.syncedAt ?? null}
          onRefresh={() => sync.mutate()}
          refreshing={sync.isPending}
        />
      </header>

      {sync.error && (
        <p className="text-closed text-sm">PeopleSoft no respondió ({sync.error.message}). Reintentar con "refrescar".</p>
      )}

      {cargando ? (
        <div className="border-line h-96 animate-pulse rounded-[var(--radius)] border" />
      ) : !tree || !summary ? (
        <div className="border-line rounded-[var(--radius)] border border-dashed p-8 text-center">
          <p className="text-sm">La trayectoria aparece cuando sincronices tu avance.</p>
          <button
            type="button"
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
            className="bg-accent text-accent-fg mt-3 rounded-[var(--radius)] px-3 py-2 text-sm font-medium disabled:opacity-50"
          >
            {sync.isPending ? 'Leyendo PeopleSoft…' : 'Traer mi avance'}
          </button>
        </div>
      ) : (
        <>
          <Posicion summary={summary} />

          <ol className="mt-2">
            {pastTerms.map((t) => (
              <TerminoNodo key={t.term} term={t} presente={t.term === current?.label} />
            ))}
            {next && (
              <ProximoNodo
                label={next.label}
                enrolled={nextEnrolled}
                cartCount={cart.data?.rows.length ?? 0}
                planes={nextPlans}
                ultimo={future.length === 0}
              />
            )}
            {future.map((b, i) => (
              <FuturoNodo key={b.id} block={b} ultimo={i === future.length - 1} />
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
