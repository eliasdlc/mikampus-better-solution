import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { SlidersHorizontal } from 'lucide-react';
import { solveMesa } from '../lib/api.ts';
import { DAY_LABELS, WEEK_DAYS, type DayCode } from '../../../src/shared/meetings.ts';
import { CAMPUS_CODES, CAMPUS_LABELS, type CampusCode } from '../../../src/shared/campus.ts';
import type { MesaSolveResponse } from '../../../src/shared/schemas.ts';

// Las condiciones que el estudiante le pone a su horario, y la propuesta que
// sale de ellas.
//
// Son CONDICIONES, no preferencias: "no puedo antes de las 10" no penaliza un
// horario, lo elimina. Por eso la respuesta trae `blocked`, las materias que se
// quedaron sin ninguna sección posible: sin eso, un "no hay combinación" no
// dice qué aflojar y la pantalla queda muerta.
//
// El techo de créditos NO está acá a propósito. La app no propone un máximo:
// propone lo que cabe dentro de tus condiciones y vos recortás. Un número
// máximo inventado (18 era el default) decide por vos algo que es tuyo.

export type CondicionesValue = {
  earliestStart: string | null;
  latestEnd: string | null;
  freeDays: DayCode[];
  maxDays: number | null;
  campuses: CampusCode[] | null;
};

export const SIN_CONDICIONES: CondicionesValue = {
  earliestStart: null,
  latestEnd: null,
  freeDays: [],
  maxDays: null,
  campuses: null,
};

const MOTIVOS: Record<string, string> = {
  'antes-de-la-hora': 'empieza antes de tu hora mínima',
  'despues-de-la-hora': 'termina después de tu hora máxima',
  'dia-que-querias-libre': 'cae en un día que pediste libre',
  'otro-campus': 'es de un campus que excluiste',
};

function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted">{label}</span>
      {children}
    </label>
  );
}

export function Condiciones({
  term,
  value,
  onChange,
  onApply,
}: {
  term: string;
  value: CondicionesValue;
  onChange: (next: CondicionesValue) => void;
  onApply: (sections: MesaSolveResponse['combinations'][number]['sections']) => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const armar = useMutation({ mutationFn: () => solveMesa({ term, constraints: value }) });
  const propuesta = armar.data?.combinations[0] ?? null;

  const toggleDay = (day: DayCode) =>
    onChange({
      ...value,
      freeDays: value.freeDays.includes(day) ? value.freeDays.filter((d) => d !== day) : [...value.freeDays, day],
    });

  const toggleCampus = (campus: CampusCode) => {
    const actual = value.campuses ?? [...CAMPUS_CODES];
    const next = actual.includes(campus) ? actual.filter((c) => c !== campus) : [...actual, campus];
    // Todos elegidos es lo mismo que sin condición, y se guarda como tal para
    // que una sección sin campus conocido no quede excluida por accidente.
    onChange({ ...value, campuses: next.length === CAMPUS_CODES.length ? null : next });
  };

  return (
    <section className="border-line bg-surface rounded-[var(--radius)] border">
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        aria-expanded={abierto}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium"
      >
        <SlidersHorizontal className="size-4" aria-hidden />
        Cómo quiero mi horario
        <span className="text-muted ml-auto text-xs">{abierto ? 'ocultar' : 'poner condiciones'}</span>
      </button>

      {abierto && (
        <div className="border-line flex flex-col gap-3 border-t px-3 py-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Campo label="No antes de">
              <input
                type="time"
                value={value.earliestStart ?? ''}
                onChange={(e) => onChange({ ...value, earliestStart: e.target.value || null })}
                className="border-line bg-bg rounded-[var(--radius)] border px-2 py-1.5 text-sm"
              />
            </Campo>
            <Campo label="No después de">
              <input
                type="time"
                value={value.latestEnd ?? ''}
                onChange={(e) => onChange({ ...value, latestEnd: e.target.value || null })}
                className="border-line bg-bg rounded-[var(--radius)] border px-2 py-1.5 text-sm"
              />
            </Campo>
            <Campo label="Máximo de días en el campus">
              <input
                type="number"
                min={1}
                max={6}
                value={value.maxDays ?? ''}
                onChange={(e) => onChange({ ...value, maxDays: e.target.value ? Number(e.target.value) : null })}
                className="border-line bg-bg rounded-[var(--radius)] border px-2 py-1.5 text-sm"
              />
            </Campo>
          </div>

          <fieldset>
            <legend className="text-muted mb-1.5 text-xs">Días que quiero libres</legend>
            <div className="flex flex-wrap gap-1.5">
              {WEEK_DAYS.map((day) => (
                <button
                  key={day}
                  type="button"
                  onClick={() => toggleDay(day)}
                  aria-pressed={value.freeDays.includes(day)}
                  className={`rounded-full border px-3 py-1 text-xs ${
                    value.freeDays.includes(day)
                      ? 'border-accent bg-accent text-accent-fg'
                      : 'border-line hover:bg-surface-2'
                  }`}
                >
                  {DAY_LABELS[day]}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-muted mb-1.5 text-xs">Campus que acepto</legend>
            <div className="flex flex-wrap gap-1.5">
              {CAMPUS_CODES.map((campus) => {
                const activo = value.campuses == null || value.campuses.includes(campus);
                return (
                  <button
                    key={campus}
                    type="button"
                    onClick={() => toggleCampus(campus)}
                    aria-pressed={activo}
                    className={`rounded-full border px-3 py-1 text-xs ${
                      activo ? 'border-accent bg-accent text-accent-fg' : 'border-line hover:bg-surface-2'
                    }`}
                  >
                    {CAMPUS_LABELS[campus]}
                  </button>
                );
              })}
            </div>
            <p className="text-muted mt-1.5 text-[11px]">
              Una sección cuyo campus no se conoce nunca se descarta: no saber no es motivo para excluirla.
            </p>
          </fieldset>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => armar.mutate()}
              disabled={armar.isPending}
              className="border-line hover:bg-surface-2 rounded-full border px-4 py-1.5 text-sm disabled:opacity-50"
            >
              {armar.isPending ? 'Armando…' : 'Ver qué cabe con estas condiciones'}
            </button>
            <button
              type="button"
              onClick={() => onChange(SIN_CONDICIONES)}
              className="text-muted hover:text-fg text-xs"
            >
              Quitar condiciones
            </button>
          </div>

          {armar.isError && <p className="text-closed text-sm">{(armar.error as Error).message}</p>}

          {armar.data && (
            <div className="border-line flex flex-col gap-2 border-t pt-3 text-sm">
              {armar.data.blocked.length > 0 && (
                <div className="border-waitlist/40 bg-waitlist/10 rounded-[var(--radius)] border px-3 py-2 text-xs">
                  <p className="text-waitlist font-medium">
                    Con estas condiciones estas materias se quedan sin ninguna sección:
                  </p>
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {armar.data.blocked.map((entry) => (
                      <li key={entry.code}>
                        <strong>{entry.code}</strong> {entry.title}:{' '}
                        {entry.reasons.map((reason) => MOTIVOS[reason] ?? reason).join(', ')}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {propuesta ? (
                <>
                  <p>
                    Cabe un horario de <strong>{propuesta.sections.length}</strong> materia(s) en{' '}
                    <strong>{propuesta.metrics.daysUsed}</strong> día(s), con{' '}
                    {Math.round(propuesta.metrics.gapMinutes / 60)}h de huecos.
                  </p>
                  <ul className="text-muted flex flex-col gap-0.5 text-xs">
                    {propuesta.sections.map((section) => (
                      <li key={section.id}>
                        {section.code} grupo {section.section ?? '?'} (NRC {section.classNbr})
                      </li>
                    ))}
                  </ul>
                  <div>
                    <button
                      type="button"
                      onClick={() => onApply(propuesta.sections)}
                      className="bg-accent text-accent-fg rounded-full px-4 py-1.5 text-sm font-medium"
                    >
                      Poner esta propuesta en la mesa
                    </button>
                  </div>
                  <p className="text-muted text-[11px]">
                    Es una propuesta, no una inscripción: cada materia queda elegida en la mesa y podés cambiarla o
                    quitarla antes de llevar nada al portal.
                  </p>
                </>
              ) : (
                <p className="text-muted">
                  Ninguna combinación cumple todas las condiciones a la vez. Aflojá una y volvé a probar.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
