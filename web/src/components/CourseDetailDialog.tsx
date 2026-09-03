import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, X } from 'lucide-react';
import { addPlanItem, addToCart, fetchPlans } from '../lib/api.ts';
import { portalCatalogNbr } from '../../../src/shared/courseCode.ts';
import { normalizeSeatStatus, type CatalogCourse, type CatalogSection } from '../../../src/shared/schemas.ts';
import { hasPractice, lectureSections } from '../../../src/shared/sections.ts';
import { SeatBadge } from './SeatBadge.tsx';
import { StalenessTag } from './StalenessTag.tsx';

// La ficha es el detalle reutilizable de una materia: la búsqueda no cambia de
// ruta para mostrar grupos ni duplica las acciones de carrito y plan.
export function CourseDetailDialog({
  course,
  open,
  onClose,
  onPick,
}: {
  course: CatalogCourse | null;
  open: boolean;
  onClose: () => void;
  onPick?: (course: CatalogCourse) => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open || !course) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-end bg-black/40 p-0 sm:items-center sm:justify-center sm:p-4" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="course-detail-title"
        onMouseDown={(event) => event.stopPropagation()}
        className="border-line bg-surface max-h-[90vh] w-full overflow-y-auto rounded-t-[var(--radius)] border p-4 shadow-2xl sm:max-w-2xl sm:rounded-[var(--radius)]"
      >
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-muted tabular font-mono text-xs">{course.code}</p>
            <h2 id="course-detail-title" className="font-display mt-1 text-xl font-semibold tracking-tight">
              {course.title}
            </h2>
            <p className="text-muted mt-1 text-sm">
              {course.credits != null ? `${course.credits} créditos · ` : ''}
              {lectureSections(course.sections).length} grupos publicados
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-muted hover:text-fg -mr-1 -mt-1 p-2" aria-label="Cerrar detalle">
            <X className="size-5" aria-hidden />
          </button>
        </header>

        {onPick && (
          <button
            type="button"
            onClick={() => {
              onPick(course);
              onClose();
            }}
            className="bg-accent text-accent-fg mt-4 flex min-h-10 items-center gap-2 rounded-[var(--radius)] px-3 py-2 text-sm font-medium"
          >
            <Plus className="size-4" aria-hidden />Agregar materia
          </button>
        )}

        {/* Grupos y prácticas van separados. Mezclarlos hacía que agregar "un
            grupo" pudiera mandar un laboratorio al carrito como si fuera la
            clase, y el portal completaba el par por su cuenta. */}
        <ul className="border-line divide-line mt-4 divide-y rounded-[var(--radius)] border">
          {lectureSections(course.sections).map((section) => (
            <SectionActions key={section.id} course={course} section={section} />
          ))}
        </ul>

        {hasPractice(course.sections) && (
          <p className="border-waitlist/40 bg-waitlist/10 text-waitlist mt-3 rounded-[var(--radius)] border px-3 py-2 text-xs">
            Esta materia tiene práctica. Desde acá se agrega solo el grupo: el portal va a elegir el laboratorio y te
            va a avisar cuál marcó. Para elegirlo vos, mandala a un plan y elegí la práctica en Inscripción.
          </p>
        )}
      </section>
    </div>
  );
}

function SectionActions({ course, section }: { course: CatalogCourse; section: CatalogSection }) {
  const qc = useQueryClient();
  const plans = useQuery({ queryKey: ['plans'], queryFn: fetchPlans });
  const [planId, setPlanId] = useState('');
  const cart = useMutation({
    mutationFn: () =>
      addToCart({
        term: section.term,
        career: course.career ?? 'GRDO',
        courseNumber: portalCatalogNbr(course),
        classNbr: section.classNbr,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cart'] }),
  });
  const plan = useMutation({
    mutationFn: (targetPlanId: number) => addPlanItem(targetPlanId, { courseId: course.id, sectionId: section.id }),
    onSuccess: (_, targetPlanId) => {
      qc.invalidateQueries({ queryKey: ['plans'] });
      qc.invalidateQueries({ queryKey: ['plan', targetPlanId] });
      setPlanId('');
    },
  });
  const meeting = section.meetings
    .map((item) => `${item.days.join(' ')} ${item.start ? `${item.start}–${item.end}` : 'TBA'}${item.room ? ` · ${item.room}` : ''}`)
    .join(' · ');

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-3 py-3 text-sm">
      <div className="min-w-0">
        <span className="tabular font-mono text-xs">{section.classNbr}</span>
        <span className="text-muted ml-2">{section.instructor || 'Sin profesor'}</span>
        {meeting && <p className="text-muted tabular mt-1 font-mono text-xs">{meeting}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {section.seats && (
          <div className="flex flex-col items-end gap-0.5">
            <SeatBadge status={normalizeSeatStatus(section.seats.status)} open={section.seats.open} capacity={section.seats.capacity} />
            <StalenessTag at={section.seatsUpdatedAt} />
          </div>
        )}
        <select
          value={planId}
          onChange={(event) => {
            const target = Number(event.target.value);
            if (target) plan.mutate(target);
          }}
          disabled={plan.isPending || (plans.data ?? []).length === 0}
          className="border-line bg-surface rounded-[var(--radius)] border px-2 py-1.5 text-xs disabled:opacity-50"
          aria-label={`Agregar ${course.code}, grupo ${section.classNbr}, a un plan`}
        >
          <option value="">{plans.data?.length ? 'Agregar al plan…' : 'Sin planes'}</option>
          {(plans.data ?? []).map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => cart.mutate()}
          disabled={cart.isPending || cart.isSuccess}
          className="border-line hover:bg-surface-2 flex min-h-8 items-center gap-1 rounded-[var(--radius)] border px-2 py-1 text-xs disabled:opacity-50"
        >
          {cart.isSuccess ? <Check className="size-3.5" aria-hidden /> : <Plus className="size-3.5" aria-hidden />}
          {cart.isSuccess ? 'En el carrito' : cart.isPending ? 'Agregando…' : 'Al carrito'}
        </button>
      </div>
      {(cart.error || plan.error) && <p className="text-closed w-full text-xs">{((cart.error ?? plan.error) as Error).message}</p>}
    </li>
  );
}
