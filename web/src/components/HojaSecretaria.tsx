import { DAY_LABELS, type DayCode } from '../../../src/shared/meetings.ts';
import { campusLabel } from '../../../src/shared/campus.ts';
import type { CatalogSection, MesaResponse } from '../../../src/shared/schemas.ts';

// La hoja que se lleva a la oficina. Es papel, no una pantalla: sin color, sin
// logo, sin QR, sin estado de cupo.
//
// Tres decisiones que la gobiernan:
//
//   1. Una fila por SECCIÓN, no por materia. La oficina teclea NRC, y el NRC es
//      la única identidad única que existe: en el ciclo 1930 hay dos secciones
//      distintas numeradas 101 en FIL-363, con NRC 5232 y 3153. Los créditos van
//      solo en la fila de la teórica para que la suma no se lea dos veces.
//   2. El NRC va primero y en negrita, porque es la columna que se teclea.
//   3. No se imprime aula (el portal la publica en 34 de 1427 secciones del
//      ciclo) ni estado de cupo (la última observación es de julio). Un dato
//      viejo impreso se lee como autoridad.

type Fila = {
  code: string;
  title: string | null;
  section: CatalogSection;
  credits: number | null;
};

function horario(section: CatalogSection): string {
  const partes = section.meetings
    .filter((meeting) => meeting.start && meeting.end)
    .map((meeting) => {
      const dias = meeting.days.map((day) => DAY_LABELS[day as DayCode] ?? day).join(' y ');
      return `${dias} ${meeting.start} a ${meeting.end}`;
    });
  // Sin horario publicado no se inventa uno: TBA es lo que dice el portal.
  return partes.length ? partes.join(' · ') : 'sin horario publicado';
}

function Tabla({ titulo, filas }: { titulo: string; filas: Fila[] }) {
  if (filas.length === 0) return null;
  return (
    <>
      <tr>
        <th colSpan={7} className="border-line border-b pt-3 pb-1 text-left text-xs font-bold">
          {titulo}
        </th>
      </tr>
      {filas.map((fila, i) => (
        <tr key={`${fila.section.classNbr}-${i}`} className="border-line/60 border-b">
          <td className="tabular py-1 pr-3 font-mono font-bold">{fila.section.classNbr}</td>
          <td className="py-1 pr-3">{fila.code}</td>
          <td className="py-1 pr-3">{fila.title ?? ''}</td>
          <td className="tabular py-1 pr-3 font-mono">{fila.section.section ?? ''}</td>
          <td className="py-1 pr-3">{fila.section.component ?? ''}</td>
          <td className="py-1 pr-3">{horario(fila.section)}</td>
          <td className="tabular py-1 text-right">{fila.credits ?? ''}</td>
        </tr>
      ))}
    </>
  );
}

export function HojaSecretaria({ mesa, nombre }: { mesa: MesaResponse; nombre?: string | null }) {
  const inscritas: Fila[] = mesa.enrolled.flatMap((course) =>
    course.sections.map((section, i) => ({
      code: course.code,
      // El título solo en la primera fila de la materia: repetirlo en la
      // práctica hace leer dos materias donde hay una.
      title: i === 0 ? course.title : null,
      section: {
        ...section,
        term: mesa.term,
        seats: null,
        seatsUpdatedAt: null,
        campus: null,
        campusSource: null,
      },
      credits: i === 0 ? course.units : null,
    }))
  );

  const solicitadas: Fila[] = (mesa.plan?.items ?? [])
    .filter((item) => item.section)
    .flatMap((item) => {
      const filas: Fila[] = [{ code: item.code, title: item.title, section: item.section!, credits: item.credits }];
      if (item.relatedSection) {
        filas.push({ code: item.code, title: null, section: item.relatedSection, credits: null });
      }
      return filas;
    });

  // Las alternativas son lo que hace útil el papel: si en la oficina dicen que
  // no hay cupo, la respuesta ya está escrita en vez de tener que volver a casa.
  const alternativas = (mesa.plan?.items ?? [])
    .filter((item) => item.section)
    .map((item) => {
      const candidata = mesa.candidates.find((course) => course.courseId === item.courseId);
      const elegido = item.section!.campus;
      const mismas = (candidata?.sections ?? []).filter(
        (section) =>
          section.component !== 'PRA' &&
          section.campus === elegido &&
          section.classNbr !== item.section!.classNbr
      );
      const otras = (candidata?.sections ?? []).filter(
        (section) => section.component !== 'PRA' && section.campus !== elegido
      );
      return { code: item.code, mismas, otras, campus: elegido };
    })
    .filter((entry) => entry.mismas.length > 0 || entry.otras.length > 0 || true);

  const total = mesa.totals.credits;

  return (
    <article className="hoja-secretaria text-fg mx-auto max-w-[46rem] text-[13px] leading-snug">
      <header className="border-line mb-3 border-b pb-2">
        <h2 className="font-display text-base font-bold">Selección de materias, ciclo {mesa.term}</h2>
        <p className="mt-1">
          Nombre: {nombre ? <strong>{nombre}</strong> : <span className="inline-block w-64 border-b" />}
        </p>
        <p className="text-muted mt-1 text-xs">
          Generada el {new Date(mesa.generatedAt).toLocaleDateString('es-DO', { dateStyle: 'long' })}.
          {mesa.phase.until && ` Cierre de inscripción: ${mesa.phase.until}.`}
        </p>
      </header>

      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-line border-b-2 text-xs">
            <th className="py-1 pr-3 font-bold">NRC</th>
            <th className="py-1 pr-3 font-bold">Código</th>
            <th className="py-1 pr-3 font-bold">Materia</th>
            <th className="py-1 pr-3 font-bold">Sec</th>
            <th className="py-1 pr-3 font-bold">Comp</th>
            <th className="py-1 pr-3 font-bold">Días y hora</th>
            <th className="py-1 text-right font-bold">Cr</th>
          </tr>
        </thead>
        <tbody>
          <Tabla titulo="Ya inscrito" filas={inscritas} />
          <Tabla titulo="Solicitado, en orden de prioridad" filas={solicitadas} />
        </tbody>
        <tfoot>
          <tr className="border-line border-t-2">
            <td colSpan={6} className="py-2 text-right font-medium">
              Ya inscrito {mesa.totals.enrolledCourses} materia(s) ({mesa.totals.enrolledCredits} cr). Solicitado{' '}
              {mesa.totals.selectedCourses} materia(s) ({mesa.totals.selectedCredits} cr). Total de créditos
            </td>
            <td className="tabular py-2 text-right text-base font-bold">{total}</td>
          </tr>
        </tfoot>
      </table>

      {alternativas.length > 0 && (
        <section className="mt-4">
          <h3 className="text-xs font-bold">Si no hay cupo</h3>
          <ul className="mt-1 flex flex-col gap-1 text-xs">
            {alternativas.map((entry) => (
              <li key={entry.code}>
                <strong>{entry.code}.</strong>{' '}
                {entry.mismas.length > 0 ? (
                  <>
                    Otras secciones en {campusLabel(entry.campus)}:{' '}
                    {entry.mismas.map((section) => `${section.section} (NRC ${section.classNbr})`).join(', ')}.
                  </>
                ) : (
                  <>No hay otra sección en {campusLabel(entry.campus)}.</>
                )}
                {entry.otras.length > 0 && (
                  <>
                    {' '}
                    En otro campus:{' '}
                    {entry.otras
                      .map((section) => `${section.section} (NRC ${section.classNbr}, ${campusLabel(section.campus)})`)
                      .join(', ')}
                    .
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="text-muted mt-4 text-[11px] leading-relaxed">
        <p>
          El campus sale del número de sección (1xx Santiago, 2xx Santo Domingo), no de una etiqueta del portal.
        </p>
        <p>
          Esta hoja no imprime aula (el portal no la publica para casi ninguna sección) ni estado de cupo
          {mesa.seats.capturedAt && ` (la última observación es del ${mesa.seats.capturedAt.slice(0, 10)})`}.
        </p>
      </footer>
    </article>
  );
}
