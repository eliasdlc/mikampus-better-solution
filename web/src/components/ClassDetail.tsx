import { useEffect, useRef } from 'react';
import { MapPin, User, X } from 'lucide-react';
import type { Block } from '../lib/grid.ts';
import { DAY_LABELS } from '../../../src/shared/meetings.ts';
import { courseColor } from '../lib/color.ts';

// El detalle de una clase del horario (P4 §5).
//
// Antes toda esta información vivía en un `title=` nativo del bloque: aparecía
// solo con el mouse encima, después de un segundo, sin poder seleccionarse y
// sin existir en teclado ni en touch. Ahora es un diálogo real que abre por
// click, tap o Enter, y toda la información del hover tiene equivalente.

export function ClassDetail({
  block,
  onClose,
  syncedAt,
}: {
  block: Block | null;
  onClose: () => void;
  syncedAt?: string | null;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!block) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    // El foco entra al diálogo al abrir: si no, Tab seguiría recorriendo la
    // página de atrás y un lector de pantalla nunca anunciaría que abrió algo.
    closeRef.current?.focus();
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [block, onClose]);

  if (!block) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="class-detail-title"
        className="border-line bg-surface w-full max-w-md overflow-hidden rounded-t-[var(--radius)] border sm:rounded-[var(--radius)]"
      >
        <div className="h-1.5" style={{ background: courseColor(block.code) }} aria-hidden />

        <div className="flex items-start justify-between gap-3 p-4 pb-2">
          <h2 id="class-detail-title" className="font-display text-xl leading-tight font-semibold tracking-tight text-balance">
            {block.title}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="text-muted hover:text-fg hover:bg-surface-2 -m-1 shrink-0 rounded-[var(--radius)] p-1"
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>

        <dl className="space-y-2.5 px-4 pb-4 text-sm">
          <Row label="Cuándo">
            <span className="tabular font-mono">
              {DAY_LABELS[block.day]} · {block.start}–{block.end}
            </span>
          </Row>

          <Row label="Dónde">
            <span className="inline-flex items-center gap-1.5">
              <MapPin className="text-muted size-4 shrink-0" aria-hidden />
              <span className="font-medium">{block.room ?? 'Aula por definir'}</span>
            </span>
          </Row>

          <Row label="Con quién">
            <span className="inline-flex items-center gap-1.5">
              <User className="text-muted size-4 shrink-0" aria-hidden />
              {/* "Profesor no publicado" y no un guión: el portal a veces
                  simplemente no lo publica, y eso es un hecho, no un hueco. */}
              <span className={block.instructor ? '' : 'text-muted'}>{block.instructor ?? 'Profesor no publicado'}</span>
            </span>
          </Row>

          <Row label="Identificación">
            <span className="tabular text-muted font-mono text-xs">
              {block.code} · NRC {block.classNbr}
              {block.section ? ` · ${block.section}` : ''}
              {block.component ? ` · ${block.component}` : ''}
            </span>
          </Row>

          {syncedAt && (
            <Row label="Fuente">
              <span className="text-muted text-xs">PeopleSoft · leído {new Date(syncedAt).toLocaleString('es-DO')}</span>
            </Row>
          )}
        </dl>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="text-muted w-28 shrink-0 text-xs tracking-wide uppercase">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}
