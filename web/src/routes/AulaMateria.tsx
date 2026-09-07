import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ChevronDown, ChevronLeft, ExternalLink, FileText, Link2, ListChecks, MessageSquare, Type } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { fetchAulaCourse } from '../lib/api.ts';
import { moduleKind, moduleMeta, whenLabel } from '../lib/aula.ts';
import type { AulaModule } from '../../../src/shared/schemas.ts';

// Una materia del aula (fase 7, decisión 1A): el estado arriba y las unidades
// del profesor abajo.
//
// La medida que decidió la forma: un curso real tiene 88 módulos en 5
// secciones, y solo 12 de ellos son tareas. Abrirlos todos es una pared de
// scroll donde lo urgente queda enterrado entre 37 enlaces; tirar las unidades
// pierde la única organización que el profesor sí dio. Por eso el estado va
// arriba, resuelto, y las unidades van plegadas con su cuenta.

const ICONO: Record<string, LucideIcon> = {
  assign: ListChecks,
  resource: FileText,
  page: FileText,
  folder: FileText,
  url: Link2,
  forum: MessageSquare,
  label: Type,
};

function Modulo({ module }: { module: AulaModule }) {
  const Icono = ICONO[module.modname] ?? FileText;
  const urgente = module.assignment && module.assignment.submitted !== true;
  const contenido = (
    <>
      <span
        className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-[4px] ${
          module.modname === 'assign' ? 'bg-accent/10 text-accent' : 'bg-surface-2 text-muted'
        }`}
        aria-hidden
      >
        <Icono className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm leading-snug font-medium">{module.name}</span>
        <span className="text-muted mt-0.5 block text-xs">{moduleMeta(module)}</span>
      </span>
      {module.dueAt && (
        <span className={`tabular shrink-0 pt-0.5 font-mono text-[11px] ${urgente ? 'text-closed' : 'text-muted'}`}>
          {whenLabel(module.dueAt)}
        </span>
      )}
    </>
  );

  // Un label se pinta y no se abre; un módulo sin url tampoco. Presentarlos como
  // enlace lleva a un 404 y enseña a desconfiar del resto.
  const abrible = module.url && !module.inlineOnly;
  return (
    <li>
      {abrible ? (
        <a
          href={module.url!}
          target="_blank"
          rel="noreferrer"
          aria-label={`${moduleKind(module.modname)}: ${module.name}`}
          className="hover:bg-surface-2 focus-visible:outline-accent flex min-h-11 w-full items-start gap-3 px-3 py-2.5 transition-colors duration-100 focus-visible:outline-2 focus-visible:-outline-offset-2"
        >
          {contenido}
          <ExternalLink className="text-muted mt-0.5 size-3.5 shrink-0" aria-hidden />
        </a>
      ) : (
        <div className="flex min-h-11 w-full items-start gap-3 px-3 py-2.5">{contenido}</div>
      )}
    </li>
  );
}

export function AulaMateria() {
  const { courseId } = useParams();
  const id = Number(courseId);
  const { data, isPending, error } = useQuery({
    queryKey: ['aula-materia', id],
    queryFn: () => fetchAulaCourse(id),
    enabled: Number.isInteger(id),
  });

  // La unidad que contiene lo próximo se abre sola: es la que se estaba
  // buscando. Sin nada pendiente, la última con contenido, que es donde va el
  // curso.
  const inicial = useMemo(() => {
    if (!data) return null;
    const conProximo = data.next
      ? data.sections.find((section) => section.modules.some((module) => module.cmid === data.next!.cmid))
      : null;
    const ultima = [...data.sections].reverse().find((section) => section.modules.length > 0);
    return (conProximo ?? ultima)?.sectionId ?? null;
  }, [data]);
  const [abierta, setAbierta] = useState<number | null>(null);
  const abiertaReal = abierta ?? inicial;

  if (isPending) {
    return <div className="border-line text-muted grid h-40 place-items-center rounded-[var(--radius)] border text-sm">Cargando…</div>;
  }
  if (error) return <p className="text-closed text-sm">No se pudo leer esa materia: {error.message}</p>;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <header>
        <Link to="/aula" className="text-muted hover:text-fg -ml-1 inline-flex min-h-8 items-center gap-1 text-sm">
          <ChevronLeft className="size-4" aria-hidden />
          Aula
        </Link>
        <h1 className="font-display mt-1 text-2xl leading-tight font-semibold">{data.course.fullname}</h1>
        <p className="text-muted tabular font-mono text-xs">{data.course.shortname}</p>
      </header>

      {/* El estado: las dos preguntas que se hacen antes de entrar a una
          materia. Van resueltas arriba, no escondidas entre 88 módulos. */}
      <div className="grid grid-cols-2 gap-2">
        <div className="border-line bg-surface rounded-[var(--radius)] border p-3">
          <p className="text-muted text-[10px] font-semibold tracking-wide uppercase">Lo próximo</p>
          {data.next?.dueAt ? (
            <>
              <p className="text-closed mt-1 text-lg leading-none font-semibold">{whenLabel(data.next.dueAt)}</p>
              <p className="text-muted mt-1 line-clamp-2 text-xs">{data.next.name}</p>
            </>
          ) : (
            <>
              <p className="mt-1 text-lg leading-none font-semibold">sin fecha</p>
              <p className="text-muted mt-1 text-xs">
                {data.pending > 0 ? `${data.pending} tarea(s) sin fecha publicada` : 'Ninguna tarea pendiente con fecha'}
              </p>
            </>
          )}
        </div>

        <div className="border-line bg-surface rounded-[var(--radius)] border p-3">
          <p className="text-muted text-[10px] font-semibold tracking-wide uppercase">Nota del aula</p>
          {data.grade.hidden ? (
            <>
              <p className="mt-1 text-lg leading-none font-semibold">oculta</p>
              {/* Un libro cerrado NO es un cero: se dice por qué y dónde sí se
                  puede ver la nota. */}
              <p className="text-muted mt-1 text-xs">{data.grade.reason}</p>
            </>
          ) : (
            <>
              <p className="mt-1 text-lg leading-none font-semibold">
                {data.grade.total ?? '—'}
                {data.grade.total && <span className="text-muted ml-1 text-xs font-medium">/100</span>}
              </p>
              <p className="text-muted mt-1 text-xs">
                {data.grade.gradableItems
                  ? `${data.grade.gradedItems} de ${data.grade.gradableItems} items calificados`
                  : 'El libro no tiene items calificables'}
              </p>
            </>
          )}
        </div>
      </div>

      {!data.contentsSynced ? (
        <div className="border-line rounded-[var(--radius)] border border-dashed p-6 text-center">
          <p className="text-sm">Todavía no se bajó el contenido de esta materia.</p>
          <p className="text-muted mt-1 text-xs">
            Sus unidades y materiales no se pueden mostrar hasta la próxima sincronización del aula.
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {data.sections.map((section) => {
            const tareas = section.modules.filter((module) => module.modname === 'assign').length;
            const abierto = abiertaReal === section.sectionId;
            return (
              <section key={section.sectionId}>
                <h2>
                  <button
                    type="button"
                    onClick={() => setAbierta(abierto ? -1 : section.sectionId)}
                    aria-expanded={abierto}
                    className={`border-line bg-surface hover:bg-surface-2 focus-visible:outline-accent flex min-h-11 w-full items-center gap-2 border px-3 py-2.5 text-left transition-colors duration-100 focus-visible:outline-2 ${
                      abierto ? 'rounded-t-[var(--radius)]' : 'rounded-[var(--radius)]'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">{section.name}</span>
                    <span className="bg-surface-2 text-muted tabular shrink-0 rounded-full px-2 py-0.5 font-mono text-[11px]">
                      {section.modules.length}
                      {tareas > 0 ? ` · ${tareas} tarea${tareas === 1 ? '' : 's'}` : ''}
                    </span>
                    <ChevronDown
                      className={`text-muted size-4 shrink-0 transition-transform duration-150 ${abierto ? 'rotate-180' : ''}`}
                      aria-hidden
                    />
                  </button>
                </h2>
                {abierto &&
                  (section.modules.length ? (
                    <ul className="border-line divide-line divide-y rounded-b-[var(--radius)] border border-t-0">
                      {section.modules.map((module) => (
                        <Modulo key={module.cmid} module={module} />
                      ))}
                    </ul>
                  ) : (
                    <p className="border-line text-muted rounded-b-[var(--radius)] border border-t-0 px-3 py-2.5 text-xs">
                      El profesor creó esta unidad y todavía no le puso contenido.
                    </p>
                  ))}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
