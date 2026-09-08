import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, ExternalLink, Search, X } from 'lucide-react';
import { fetchTextoDocumento, urlDocumento } from '../lib/api.ts';
import type { Documento } from '../../../src/shared/schemas.ts';

// Un documento del aula, abierto adentro de mikampus (decisión 3A).
//
// El archivo sale del blob que el agente ya bajó, así que abrirlo no toca la
// PVA y funciona sin conexión. Lo que hace que valga la pena leerlo acá y no en
// la plataforma es la búsqueda: el texto ya está extraído e indexado, y este
// visor lo usa para llevarte al párrafo en vez de al archivo.

const KB = 1024;
export const tamano = (bytes: number) =>
  bytes <= 0 ? 'peso sin declarar' : bytes < KB * KB ? `${Math.round(bytes / KB)} KB` : `${(bytes / KB / KB).toFixed(1)} MB`;

/** Los formatos que un navegador muestra sin ayuda de nadie. */
function seVeSolo(mimetype: string | null): boolean {
  const tipo = mimetype ?? '';
  return tipo === 'application/pdf' || tipo.startsWith('image/') || tipo.startsWith('text/');
}

/** Los pedazos del texto donde aparece lo buscado, con su contexto. */
function coincidencias(content: string, query: string, limite = 12) {
  const termino = query.trim().toLowerCase();
  if (termino.length < 2) return [];
  const plano = content.replace(/\s+/g, ' ');
  const encontrados: { antes: string; hit: string; despues: string }[] = [];
  let desde = 0;
  while (encontrados.length < limite) {
    const posicion = plano.toLowerCase().indexOf(termino, desde);
    if (posicion === -1) break;
    encontrados.push({
      antes: plano.slice(Math.max(0, posicion - 60), posicion),
      hit: plano.slice(posicion, posicion + termino.length),
      despues: plano.slice(posicion + termino.length, posicion + termino.length + 80),
    });
    desde = posicion + termino.length;
  }
  return encontrados;
}

export function DocumentoSheet({ documento, onClose }: { documento: Documento; onClose: () => void }) {
  const [query, setQuery] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const { data: texto } = useQuery({
    queryKey: ['documento-texto', documento.fileId],
    queryFn: () => fetchTextoDocumento(documento.fileId),
    enabled: documento.indexed,
    retry: false,
  });

  const hits = useMemo(() => (texto ? coincidencias(texto.content, query) : []), [texto, query]);
  const visible = documento.downloaded && seVeSolo(documento.mimetype);

  return (
    <div className="fixed inset-0 z-[70] flex items-end bg-black/50 sm:items-center sm:justify-center sm:p-4" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={documento.filename}
        onMouseDown={(event) => event.stopPropagation()}
        className="border-line bg-surface flex max-h-[94vh] w-full flex-col overflow-hidden rounded-t-[var(--radius)] border shadow-2xl sm:max-w-3xl sm:rounded-[var(--radius)]"
      >
        <header className="border-line flex items-start justify-between gap-3 border-b p-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{documento.filename}</h2>
            <p className="text-muted mt-0.5 text-xs">
              {[documento.sectionName, documento.moduleName].filter(Boolean).join(' · ') || 'Sin unidad'}
              {' · '}
              {tamano(documento.bytes)}
              {documento.pages ? ` · ${documento.pages} páginas` : ''}
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-muted hover:text-fg -mt-1 -mr-1 p-2" aria-label="Cerrar">
            <X className="size-5" aria-hidden />
          </button>
        </header>

        {documento.indexed && (
          <div className="border-line border-b px-4 py-2">
            <label className="border-line bg-bg flex min-h-10 items-center gap-2 rounded-full border px-3">
              <Search className="text-muted size-4 shrink-0" aria-hidden />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar dentro de este documento"
                className="w-full bg-transparent text-sm outline-none"
              />
              {query && <span className="text-muted tabular shrink-0 font-mono text-xs">{hits.length}</span>}
            </label>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {query.trim().length >= 2 ? (
            hits.length ? (
              <ul className="divide-line divide-y">
                {hits.map((hit, indice) => (
                  <li key={indice} className="px-4 py-3 text-sm leading-relaxed">
                    <span className="text-muted">…{hit.antes}</span>
                    <mark className="bg-accent/20 text-fg rounded px-0.5">{hit.hit}</mark>
                    <span className="text-muted">{hit.despues}…</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted p-6 text-center text-sm">Ese texto no aparece en este documento.</p>
            )
          ) : visible ? (
            // El navegador ya sabe mostrar PDF, imagen y texto plano. Para el
            // resto, mostrar un visor a medias sería peor que decir la verdad.
            <embed src={urlDocumento(documento.fileId)} type={documento.mimetype ?? undefined} className="h-[60vh] w-full" />
          ) : documento.downloaded ? (
            <div className="p-6 text-center">
              <p className="text-sm">Este formato no se puede mostrar acá.</p>
              <p className="text-muted mt-1 text-xs">
                {documento.indexed
                  ? 'Su texto sí está indexado: buscá arriba, o bajalo para abrirlo con tu programa.'
                  : 'Bajalo para abrirlo con el programa que ya usás.'}
              </p>
            </div>
          ) : (
            <div className="p-6 text-center">
              <p className="text-sm">Todavía no está bajado.</p>
              <p className="text-muted mt-1 text-xs">
                {documento.lastError
                  ? `El último intento falló: ${documento.lastError}`
                  : 'Bajá el material de la materia y vuelve a aparecer acá para leerlo.'}
              </p>
            </div>
          )}
        </div>

        <footer className="border-line flex items-center gap-2 border-t p-3">
          {documento.downloaded && (
            <a
              href={urlDocumento(documento.fileId, { descargar: true })}
              download={documento.filename}
              className="border-line hover:bg-surface-2 flex min-h-10 flex-1 items-center justify-center gap-2 rounded-full border text-sm font-medium"
            >
              <Download className="size-4" aria-hidden />
              Descargar
            </a>
          )}
          {documento.moduleUrl && (
            <a
              href={documento.moduleUrl}
              target="_blank"
              rel="noreferrer"
              className="border-line hover:bg-surface-2 flex min-h-10 flex-1 items-center justify-center gap-2 rounded-full border text-sm font-medium"
            >
              Abrir en la PVA
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          )}
        </footer>
      </section>
    </div>
  );
}
