import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { fetchDegreePath } from '../lib/api.ts';
import type { DegreePathResponse } from '../../../src/shared/schemas.ts';
import { CourseChip } from './CourseChip.tsx';

// La ruta a graduación.
//
// La pregunta que esta pantalla contesta no es "cuánto me falta" —eso ya lo
// decía el conteo de créditos— sino "cuándo termino y qué me está frenando".
// Son dos cosas distintas y la segunda es la accionable: si te frena la cadena
// de prerrequisitos, meter más créditos por ciclo no adelanta un solo día; si te
// frena la carga, sí. Por eso el selector de carga está acá arriba y no
// escondido en ajustes: mover 18 a 21 y ver que el número NO cambia es la forma
// más rápida de entender contra qué estás peleando.
//
// Todo el cálculo es local (§ src/shared/degreePath.ts). Abrir esto no sale al
// portal ni encola nada.

const CARGAS = [12, 15, 18, 21, 24];

// La carga es estado del padre, no de este componente: el encabezado de la
// pantalla muestra el mismo número de ciclos y tiene que moverse con el
// selector. React Query deduplica la consulta, así que ambos leen una sola.
export function DegreePath({
  maxCredits,
  onMaxCredits,
}: {
  maxCredits: number;
  onMaxCredits: (value: number) => void;
}) {
  const path = useQuery({
    queryKey: ['degree-path', maxCredits],
    queryFn: () => fetchDegreePath(maxCredits),
    // La ruta anterior sigue en pantalla mientras se recalcula la nueva: sin
    // esto, cambiar la carga parpadea a un esqueleto y se pierde justamente la
    // comparación que el control existe para hacer.
    placeholderData: (previous) => previous,
  });

  if (path.isPending) {
    return <div className="border-line text-muted grid h-52 place-items-center rounded-[var(--radius)] border text-sm">Cargando…</div>;
  }
  if (path.error) {
    return (
      <p className="border-line text-muted rounded-[var(--radius)] border border-dashed p-4 text-sm">
        No se pudo calcular la ruta: {path.error.message}
      </p>
    );
  }

  const data = path.data!;
  if (!data.available) {
    return (
      <section className="border-line rounded-[var(--radius)] border border-dashed p-4">
        <h2 className="font-display text-base font-semibold tracking-tight">Ruta a graduación</h2>
        <p className="text-muted mt-1 text-sm">{data.reason ?? 'Todavía no hay datos suficientes.'}</p>
      </section>
    );
  }

  return (
    <section className="border-line bg-surface rounded-[var(--radius)] border">
      <Encabezado data={data} maxCredits={maxCredits} onMaxCredits={onMaxCredits} recalculando={path.isFetching} />
      <Freno data={data} />
      {data.criticalPath.length >= 2 && <Cadena data={data} />}
      {data.bottlenecks.length > 0 && <Cuellos data={data} />}
      <Ciclos data={data} />
      {data.unscheduled.length > 0 && <FueraDeRuta data={data} />}
      <Salvedades data={data} />
    </section>
  );
}

function Encabezado({
  data,
  maxCredits,
  onMaxCredits,
  recalculando,
}: {
  data: DegreePathResponse;
  maxCredits: number;
  onMaxCredits: (value: number) => void;
  recalculando: boolean;
}) {
  return (
    <div className="border-line flex flex-wrap items-end justify-between gap-4 border-b p-4">
      <div className="min-w-0">
        <div className="text-muted text-xs tracking-wide uppercase">Ruta a graduación</div>
        <div className="font-display mt-1 text-2xl font-semibold tracking-tight">
          <span className="tabular">{data.termsRemaining}</span>{' '}
          {data.termsRemaining === 1 ? 'ciclo' : 'ciclos'}
          {data.graduationTerm && (
            <span className="text-muted text-base font-normal"> · cerrás en {data.graduationTerm}</span>
          )}
        </div>
        <div className="text-muted tabular mt-0.5 text-xs">
          {data.coursesRemaining} {data.coursesRemaining === 1 ? 'materia' : 'materias'} · {data.creditsRemaining}{' '}
          créditos por delante
        </div>
      </div>

      {/* El control que vuelve accionable el número. Es la carga máxima por
          ciclo, no una preferencia guardada: se recalcula y se mira. */}
      <label className="flex shrink-0 flex-col gap-1">
        <span className="text-muted text-xs">Carga por ciclo</span>
        <select
          value={maxCredits}
          onChange={(event) => onMaxCredits(Number(event.target.value))}
          className="border-line bg-surface-2 tabular tap rounded-[var(--radius)] border px-2 py-1.5 font-mono text-sm"
        >
          {CARGAS.map((value) => (
            <option key={value} value={value}>
              {value} créditos
            </option>
          ))}
        </select>
        <span className={`text-muted text-[11px] ${recalculando ? 'opacity-100' : 'opacity-0'}`}>recalculando…</span>
      </label>
    </div>
  );
}

// El hallazgo. De las dos restricciones —la cadena de prerrequisitos y el techo
// de créditos— una manda, y decir cuál es lo único que convierte "te faltan 6
// ciclos" en una decisión.
function Freno({ data }: { data: DegreePathResponse }) {
  const texto =
    data.binding === 'prerrequisitos'
      ? `Te frena la cadena de prerrequisitos, no la carga. Aunque tomaras más créditos por ciclo, seguirías necesitando ${data.chainFloor} ${data.chainFloor === 1 ? 'ciclo' : 'ciclos'}: hay materias que solo se pueden cursar una detrás de otra.`
      : data.binding === 'carga'
        ? `Te frena la carga, no los prerrequisitos. Lo que falta se podría cursar en ${data.chainFloor} ${data.chainFloor === 1 ? 'ciclo' : 'ciclos'} si cupiera; con ${data.maxCredits} créditos por ciclo hacen falta ${data.loadFloor}. Subir la carga sí adelanta.`
        : `Las dos restricciones se tocan: la cadena más larga pide ${data.chainFloor} ${data.chainFloor === 1 ? 'ciclo' : 'ciclos'} y los créditos que faltan, ${data.loadFloor}. Subir la carga adelanta poco.`;

  return (
    <div className="border-line border-b p-4">
      <p className="text-sm text-pretty">{texto}</p>
    </div>
  );
}

// La cadena más larga que queda. Cuidado con lo que se afirma de ella: solo
// FIJA la fecha cuando es el freno. Si el freno es la carga, la cadena tiene
// holgura y reprobar un eslabón NO corre necesariamente la graduación — decirlo
// igual sería asustar con un número que la propia app calculó en contra.
function Cadena({ data }: { data: DegreePathResponse }) {
  const manda = data.chainFloor >= data.termsRemaining;
  return (
    <div className="border-line border-b p-4">
      <h3 className="text-muted text-xs font-medium tracking-wide uppercase">
        {manda ? 'La cadena que fija la fecha' : 'La cadena más larga que te queda'} · {data.criticalPath.length}{' '}
        {data.criticalPath.length === 1 ? 'materia' : 'materias'}
      </h3>
      <ol className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-2">
        {data.criticalPath.map((course, index) => (
          <li key={course.code} className="flex items-center gap-1.5">
            {index > 0 && (
              <span className="text-muted text-xs" aria-label="antes de">
                →
              </span>
            )}
            <CourseChip code={course.code} title={course.title} size="sm" />
          </li>
        ))}
      </ol>
      <p className="text-muted mt-2 text-xs text-pretty">
        {manda
          ? 'Van obligatoriamente una detrás de otra y no les sobra ningún ciclo: reprobar cualquiera de ellas corre la graduación un ciclo completo. Reprobar una materia fuera de esta cadena, no.'
          : `Van obligatoriamente una detrás de otra, pero hoy no fijan tu fecha: te frena la carga y les sobran ${data.termsRemaining - data.chainFloor} ${data.termsRemaining - data.chainFloor === 1 ? 'ciclo' : 'ciclos'} de holgura. Es la primera que empieza a mandar si te atrasás.`}
      </p>
    </div>
  );
}

function Cuellos({ data }: { data: DegreePathResponse }) {
  return (
    <div className="border-line border-b p-4">
      <h3 className="text-muted text-xs font-medium tracking-wide uppercase">Lo que más te cuesta atrasar</h3>
      <ul className="divide-line mt-1 divide-y">
        {data.bottlenecks.map((course) => (
          <li key={course.code} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
            <CourseChip code={course.code} title={course.title} size="sm" />
            <span className="text-muted tabular shrink-0 text-xs">
              {course.unlocks > 0 && `destraba ${course.unlocks}`}
              {course.unlocks > 0 && course.chainLength > 1 && ' · '}
              {course.chainLength > 1 && `${course.chainLength} ciclos por delante`}
              {' · ciclo '}
              {course.termIndex}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// La ruta ciclo por ciclo. Plegada por defecto: el número y el freno son lo que
// se viene a ver; el detalle es para cuando ya decidiste mirarlo.
function Ciclos({ data }: { data: DegreePathResponse }) {
  const [abierto, setAbierto] = useState(false);
  return (
    <div className="border-line border-b p-4">
      <button
        type="button"
        onClick={() => setAbierto((value) => !value)}
        aria-expanded={abierto}
        className="text-muted hover:text-fg flex items-center gap-1.5 text-xs"
      >
        {abierto ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
        Ver la ruta ciclo por ciclo
      </button>

      {abierto && (
        <ol className="mt-3 space-y-3">
          {data.terms.map((term) => (
            <li key={term.index} className="border-line rounded-[var(--radius)] border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h4 className="font-display text-sm font-semibold tracking-tight">
                  {term.label ?? `Ciclo ${term.index}`}
                  {term.index === 1 && <span className="text-accent ml-2 text-xs font-medium">el próximo</span>}
                </h4>
                <span className="text-muted tabular text-xs">{term.credits} cr</span>
              </div>
              <ul className="mt-2 space-y-1.5">
                {term.courses.map((course) => (
                  <li key={course.code} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    {course.kind === 'electiva' ? (
                      <span className="text-muted text-sm">{course.title} · cupo por elegir</span>
                    ) : (
                      <CourseChip code={course.code} title={course.title} size="sm" />
                    )}
                    <span className="text-muted tabular shrink-0 text-xs">
                      {course.critical && <span className="text-closed font-medium">sin holgura · </span>}
                      {course.requiredBy ? `va con ${course.requiredBy}` : course.blockLabel}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}

      {/* El primer ciclo de la ruta es teórico: asume que todo se oferta. El
          recomendador es el que sabe qué hay de verdad en el catálogo de este
          ciclo, con grupos y horarios reales. */}
      <p className="text-muted mt-3 text-xs text-pretty">
        El primer ciclo de la ruta asume que todo se oferta.{' '}
        <Link to="/inscripcion?recomendado=1" className="text-accent hover:underline">
          Armá el plan real del próximo ciclo
        </Link>{' '}
        para verlo contra los grupos y horarios que existen.
      </p>
    </div>
  );
}

function FueraDeRuta({ data }: { data: DegreePathResponse }) {
  return (
    <div className="border-line border-b p-4">
      <h3 className="text-closed text-xs font-medium tracking-wide uppercase">Fuera de la ruta</h3>
      <ul className="mt-2 space-y-2">
        {data.unscheduled.map((course) => (
          <li key={course.code}>
            <CourseChip code={course.code} title={course.title} size="sm" />
            <p className="text-muted mt-1 text-xs text-pretty">{course.reason}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Salvedades({ data }: { data: DegreePathResponse }) {
  return (
    <div className="p-4">
      <ul className="text-muted space-y-1 text-xs">
        {data.caveats.map((caveat) => (
          <li key={caveat} className="text-pretty">
            {caveat}
          </li>
        ))}
      </ul>
    </div>
  );
}
