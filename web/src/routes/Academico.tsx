import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchGrades, syncGrades, fetchPensum, syncPensum } from '../lib/api.ts';
import { CourseChip } from '../components/CourseChip.tsx';
import { StalenessTag } from '../components/StalenessTag.tsx';
import { GRADE_POINTS, formatGpa, roundGpa, summarizeGrades } from '../../../src/shared/gpa.ts';
import type { GradesResponse, PensumResponse, TermGrades } from '../../../src/shared/schemas.ts';

// Notas y avance (plan §5.6). Dos tabs: el histórico con el índice y el
// simulador what-if, y el pénsum con el estado de cada materia.

// La única gráfica de la app, y se la gana: la evolución real del índice por
// término. Sin ejes ni leyenda — es una forma, no un tablero.
function Sparkline({ terms }: { terms: TermGrades[] }) {
  // Del más viejo al más nuevo, y solo los términos que tienen índice: uno en
  // curso no vale 0, no vale nada.
  const points = terms
    .filter((t) => t.gpa !== null)
    .slice()
    .reverse();
  if (points.length < 2) return null;

  const w = 132;
  const h = 34;
  const values = points.map((p) => p.gpa!);
  // Escala fija 0–4: con escala automática, un índice entre 2.6 y 2.8 se vería
  // como una montaña rusa. La forma tiene que decir la verdad.
  const y = (v: number) => h - (v / 4) * h;
  const x = (i: number) => (i / (points.length - 1)) * w;
  const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const last = values.at(-1)!;

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="overflow-visible"
      role="img"
      aria-label={`Evolución del índice por término: ${values.map((v) => v.toFixed(2)).join(', ')}`}
    >
      <path d={d} fill="none" stroke="var(--muted)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(values.length - 1)} cy={y(last)} r="2.5" fill="var(--accent)" />
    </svg>
  );
}

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
        <div className="sm:justify-self-end sm:self-center">
          <Sparkline terms={data.terms} />
        </div>
      </div>

      <section className="border-line rounded-[var(--radius)] border p-4">
        <h2 className="font-display mb-3 text-base font-semibold tracking-tight">Simulador</h2>
        <WhatIf data={data} />
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

function Avance({ data }: { data: PensumResponse }) {
  const [soloPendientes, setSoloPendientes] = useState(false);

  // El plan quería el pénsum en columnas por semestre, pero el advisement
  // report no dice a qué semestre pertenece cada materia. Se agrupa por
  // subject, que es lo que el portal sí publica.
  const porSubject = useMemo(() => {
    const m = new Map<string, PensumResponse['courses']>();
    for (const c of data.courses) {
      if (soloPendientes && c.status !== 'pending') continue;
      if (!m.has(c.subject)) m.set(c.subject, []);
      m.get(c.subject)!.push(c);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data, soloPendientes]);

  const pendientes = data.courses.filter((c) => c.status === 'pending');
  const ofertadas = pendientes.filter((c) => c.offered);

  return (
    <div className="space-y-5">
      <div className="border-line flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border p-4">
        <div className="flex flex-wrap gap-5">
          <BigNumber label="Aprobadas" value={String(data.courses.filter((c) => c.status === 'taken').length)} />
          <BigNumber label="Pendientes" value={String(pendientes.length)} />
          <BigNumber
            label="Se ofertan"
            value={String(ofertadas.length)}
            hint={data.term ? `pendientes con grupos en ${data.term}` : 'sin término activo'}
          />
        </div>
        <button
          type="button"
          onClick={() => setSoloPendientes((v) => !v)}
          aria-pressed={soloPendientes}
          className={`min-h-8 rounded-full px-3 py-1 text-xs transition-colors duration-100 ${
            soloPendientes ? 'bg-accent text-accent-fg font-medium' : 'border-line text-muted hover:text-fg border'
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

      <div className="space-y-5">
        {porSubject.map(([subject, courses]) => (
          <section key={subject}>
            <h3 className="text-muted mb-2 font-mono text-xs tracking-wide">{subject}</h3>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {courses.map((c) => (
                <article
                  key={c.code}
                  className={`rounded-[var(--radius)] border p-2.5 ${
                    c.status === 'taken'
                      ? 'border-line bg-surface-2'
                      : c.status === 'in_progress'
                        ? 'border-accent'
                        : c.offered
                          ? 'border-open border-dashed'
                          : 'border-line border-dashed'
                  }`}
                >
                  <CourseChip code={c.code} title={c.title ?? c.code} size="sm" />
                  <div className="text-muted mt-1.5 flex items-center justify-between gap-2 text-xs">
                    <span>
                      {ESTADO_LABEL[c.status] ?? c.status}
                      {c.grade && <span className="tabular font-mono"> · {c.grade}</span>}
                    </span>
                    {c.status === 'pending' && c.offered && <span className="text-open">se oferta</span>}
                  </div>
                </article>
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
  const pensum = useQuery({ queryKey: ['pensum'], queryFn: () => fetchPensum() });

  const syncG = useMutation({
    mutationFn: syncGrades,
    onSuccess: (fresh) => queryClient.setQueryData(['grades'], fresh),
  });
  const syncP = useMutation({
    mutationFn: syncPensum,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['pensum'] }),
  });

  const activa = tab === 'notas' ? grades : pensum;
  const sync = tab === 'notas' ? syncG : syncP;
  const vacio = tab === 'notas' ? !grades.data?.terms.length : !pensum.data?.courses.length;

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
        <div className="border-line h-96 animate-pulse rounded-[var(--radius)] border" />
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
        <Avance data={pensum.data!} />
      )}
    </div>
  );
}
