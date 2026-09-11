import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileText, Search } from 'lucide-react';
import { bajarMaterial, buscarMaterial, fetchMaterial } from '../lib/api.ts';
import type { Documento } from '../../../src/shared/schemas.ts';
import { DocumentoSheet, tamano } from './DocumentoSheet.tsx';

// El material de una materia, junto (decisión 2A).
//
// La unidad sigue siendo un dato de cada archivo, pero deja de ser el único
// camino: acá la lista se ve entera y se busca por dentro con el texto que el
// agente ya indexó.

const EXT: Record<string, string> = {
  'application/pdf': 'PDF',
  'application/msword': 'DOC',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
  'text/html': 'HTML',
};

function etiqueta(documento: Documento): string {
  if (documento.mimetype && EXT[documento.mimetype]) return EXT[documento.mimetype];
  if (documento.mimetype?.startsWith('image/')) return 'IMG';
  // El nombre no garantiza extensión: 45 de 96 archivos del recon no traen
  // punto. Cuando no hay tipo, se dice que no se sabe en vez de inventar uno.
  const punto = documento.filename.lastIndexOf('.');
  return punto > 0 ? documento.filename.slice(punto + 1).slice(0, 4).toUpperCase() : '?';
}

/** El estado de un archivo, que es dato y no decoración. */
function Estado({ documento }: { documento: Documento }) {
  const [color, texto] = documento.indexed
    ? ['bg-open', 'texto']
    : documento.downloaded
      ? ['bg-accent', 'bajado']
      : ['border-line border bg-transparent', 'sin bajar'];
  return (
    <span className="text-muted flex shrink-0 items-center gap-1 text-[11px] font-semibold">
      <span className={`size-2 rounded-[2px] ${color}`} aria-hidden />
      {texto}
    </span>
  );
}

export function MaterialMateria({ courseId }: { courseId: number }) {
  const client = useQueryClient();
  const [query, setQuery] = useState('');
  const [abierto, setAbierto] = useState<Documento | null>(null);

  const { data, isPending } = useQuery({ queryKey: ['material', courseId], queryFn: () => fetchMaterial(courseId) });
  const busqueda = useQuery({
    queryKey: ['material-buscar', courseId, query],
    queryFn: () => buscarMaterial(courseId, query),
    enabled: query.trim().length >= 2,
  });

  const bajar = useMutation({
    mutationFn: (includeHeavy: boolean) => bajarMaterial(courseId, includeHeavy),
    onSuccess: () => client.invalidateQueries({ queryKey: ['material', courseId] }),
  });

  if (isPending || !data) {
    return <p className="text-muted py-8 text-center text-sm">Cargando el material…</p>;
  }

  const porId = new Map(data.documents.map((documento) => [documento.fileId, documento]));
  const buscando = query.trim().length >= 2;

  return (
    <div className="space-y-2">
      <label className="border-line bg-surface flex min-h-11 items-center gap-2 rounded-full border px-3">
        <Search className="text-muted size-4 shrink-0" aria-hidden />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Buscar en ${data.documents.length} documento${data.documents.length === 1 ? '' : 's'}`}
          className="w-full bg-transparent text-sm outline-none"
        />
      </label>

      {/* Bajar lo que falta con el peso adelante (decisión 5A): el archivo
          gigante nunca se cuela dentro de un botón que decía "todo". */}
      {(data.pending.light.files > 0 || data.pending.heavy.files > 0) && !buscando && (
        <div className="border-line bg-surface space-y-2 rounded-[var(--radius)] border p-3">
          {data.pending.light.files > 0 && (
            <button
              type="button"
              disabled={bajar.isPending}
              onClick={() => bajar.mutate(false)}
              className="bg-accent text-accent-fg min-h-11 w-full rounded-full text-sm font-semibold disabled:opacity-40"
            >
              {bajar.isPending
                ? 'Bajando…'
                : `Bajar ${data.pending.light.files} documento${data.pending.light.files === 1 ? '' : 's'} · ${tamano(data.pending.light.bytes)}`}
            </button>
          )}
          {data.pending.heavy.files > 0 && (
            <button
              type="button"
              disabled={bajar.isPending}
              onClick={() => bajar.mutate(true)}
              className="border-line hover:bg-surface-2 min-h-11 w-full rounded-full border text-sm font-medium disabled:opacity-40"
            >
              Bajar también {data.pending.heavy.files} pesado{data.pending.heavy.files === 1 ? '' : 's'} · {tamano(data.pending.heavy.bytes)}
            </button>
          )}
          {bajar.isError && <p className="text-closed text-xs">No se pudo bajar: {(bajar.error as Error).message}</p>}
          {bajar.data && (
            <p className="text-muted text-xs">
              {bajar.data.downloaded} bajado(s), {bajar.data.indexed} con texto
              {bajar.data.failed ? `, ${bajar.data.failed} fallaron` : ''}
              {bajar.data.skipped ? `, ${bajar.data.skipped} sin espacio en el presupuesto` : ''}.
            </p>
          )}
        </div>
      )}

      {buscando ? (
        busqueda.isPending ? (
          <p className="text-muted py-6 text-center text-sm">Buscando…</p>
        ) : busqueda.data?.results.length ? (
          <ul className="border-line divide-line divide-y rounded-[var(--radius)] border">
            {busqueda.data.results.map((hit) => (
              <li key={hit.fileId}>
                <button
                  type="button"
                  onClick={() => setAbierto(porId.get(hit.fileId) ?? null)}
                  className="hover:bg-surface-2 w-full px-3 py-2.5 text-left"
                >
                  <span className="block text-sm font-medium">{hit.filename}</span>
                  <span className="text-muted mt-0.5 block text-xs">
                    {[hit.sectionName, hit.moduleName].filter(Boolean).join(' · ') || 'Sin unidad'}
                  </span>
                  {/* El fragmento viene de FTS5 con « » alrededor de lo que coincide. */}
                  <span className="mt-1 block text-xs leading-relaxed">{hit.snippet}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="border-line rounded-[var(--radius)] border border-dashed p-6 text-center">
            <p className="text-sm">Nada con eso en los documentos bajados.</p>
            <p className="text-muted mt-1 text-xs">
              Solo se busca dentro de los que tienen texto extraído: {data.usage.indexed} de {data.documents.length}.
            </p>
          </div>
        )
      ) : data.documents.length ? (
        <ul className="border-line divide-line divide-y rounded-[var(--radius)] border">
          {data.documents.map((documento) => (
            <li key={documento.fileId}>
              <button
                type="button"
                onClick={() => setAbierto(documento)}
                className="hover:bg-surface-2 focus-visible:outline-accent flex min-h-11 w-full items-center gap-3 px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2"
              >
                <span className="bg-surface-2 text-muted grid size-7 shrink-0 place-items-center rounded-[4px] text-[10px] font-bold">
                  {etiqueta(documento)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{documento.filename}</span>
                  <span className="text-muted mt-0.5 block text-xs">
                    {[documento.sectionName, documento.origin === 'material' ? null : documento.origin]
                      .filter(Boolean)
                      .join(' · ') || 'Sin unidad'}
                    {' · '}
                    {tamano(documento.bytes)}
                    {documento.bytesAreDeclared && documento.bytes > 0 ? ' declarados' : ''}
                  </span>
                </span>
                <Estado documento={documento} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="border-line rounded-[var(--radius)] border border-dashed p-8 text-center">
          <FileText className="text-muted mx-auto size-6" aria-hidden />
          <p className="mt-2 text-sm">Esta materia no tiene documentos en la PVA.</p>
          <p className="text-muted mt-1 text-xs">Una de cada tres materias del recon estaba así: el profesor no subió archivos.</p>
        </div>
      )}

      {!buscando && data.documents.length > 0 && (
        <p className="text-muted flex items-center gap-1.5 text-xs">
          <Download className="size-3.5" aria-hidden />
          {data.usage.downloaded} de {data.usage.files} bajados en tu máquina, {data.usage.indexed} con texto buscable.
        </p>
      )}

      {abierto && <DocumentoSheet documento={abierto} onClose={() => setAbierto(null)} />}
    </div>
  );
}
