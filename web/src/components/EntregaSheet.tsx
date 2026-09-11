import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, ExternalLink, Paperclip, X } from 'lucide-react';
import {
  entregarTarea,
  fetchEntregaPreview,
  guardarEntrega,
  type ArchivoParaEntregar,
} from '../lib/api.ts';
import type { EntregaResult } from '../../../src/shared/schemas.ts';
import { whenLabel } from '../lib/aula.ts';

// Entregar una tarea, en dos pasos (decisión 2A): primero el ensayo, que
// muestra el payload exacto sin mandar nada, y después la entrega, que pide el
// nombre de la tarea escrito.
//
// La razón del orden: en las 17 tareas del aula no existe la etapa de
// borrador, así que guardar YA es entregar. Un botón que diga "guardar" y le
// muestre el texto al profesor es la trampa que esta pantalla existe para no
// armar.

const KB = 1024;
const tamano = (bytes: number) => (bytes < KB * KB ? `${Math.round(bytes / KB)} KB` : `${(bytes / KB / KB).toFixed(1)} MB`);

/** Un archivo del disco, en la forma que viaja por JSON. */
async function leerArchivo(file: File): Promise<ArchivoParaEntregar> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  // De a pedazos: pasarle 400 mil argumentos a fromCharCode revienta la pila.
  let binario = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binario += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return { name: file.name, mimetype: file.type || null, base64: btoa(binario) };
}

function Aviso({ tono, children }: { tono: 'alto' | 'ojo' | 'bien'; children: React.ReactNode }) {
  const estilo =
    tono === 'alto'
      ? 'border-closed/40 bg-closed/10 text-closed'
      : tono === 'ojo'
        ? 'border-accent/30 bg-accent/10 text-fg'
        : 'border-open/40 bg-open/10 text-fg';
  return (
    <p className={`mt-2 flex items-start gap-2 rounded-[var(--radius)] border px-3 py-2 text-xs leading-relaxed ${estilo}`}>
      {tono === 'bien' ? <Check className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
      <span>{children}</span>
    </p>
  );
}

export function EntregaSheet({
  assignmentId,
  courseId,
  url,
  onClose,
}: {
  assignmentId: number;
  courseId: number;
  url: string | null;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [texto, setTexto] = useState('');
  const [archivos, setArchivos] = useState<ArchivoParaEntregar[]>([]);
  const [nombre, setNombre] = useState('');
  const [acepta, setAcepta] = useState(false);
  const [ensayo, setEnsayo] = useState<EntregaResult | null>(null);
  const [hecho, setHecho] = useState<EntregaResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const { data: preview, isPending } = useQuery({
    queryKey: ['entrega', assignmentId],
    queryFn: () => fetchEntregaPreview(assignmentId),
  });

  const refrescar = () => {
    client.invalidateQueries({ queryKey: ['aula-materia', courseId] });
    client.invalidateQueries({ queryKey: ['aula'] });
    client.invalidateQueries({ queryKey: ['entrega', assignmentId] });
  };

  // El ensayo usa la MISMA ruta que el envío. Una simulación aparte podría
  // mostrar algo distinto de lo que viajaría, que es justo lo que hay que
  // evitar.
  const ver = useMutation({
    mutationFn: () => guardarEntrega(assignmentId, { body: texto, files: archivos, dryRun: true }),
    onSuccess: (result) => {
      setError(null);
      setEnsayo(result);
    },
    onError: (err: Error) => setError(err.message),
  });

  const mandar = useMutation({
    mutationFn: () => guardarEntrega(assignmentId, { body: texto, files: archivos, confirmName: nombre }),
    onSuccess: (result) => {
      setError(null);
      setHecho(result);
      refrescar();
    },
    onError: (err: Error) => setError(err.message),
  });

  const enFirme = useMutation({
    mutationFn: () => entregarTarea(assignmentId, { confirmName: nombre, acceptStatement: acepta }),
    onSuccess: (result) => {
      setError(null);
      setHecho(result);
      refrescar();
    },
    onError: (err: Error) => setError(err.message),
  });

  const trabajando = ver.isPending || mandar.isPending || enFirme.isPending;
  const hayAlgo = texto.trim().length > 0 || archivos.length > 0;
  const yaEntregada = preview?.current?.status === 'submitted';
  const enBorrador = preview?.current?.status === 'draft';

  return (
    <div className="fixed inset-0 z-[60] flex items-end bg-black/40 sm:items-center sm:justify-center sm:p-4" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="entrega-title"
        onMouseDown={(event) => event.stopPropagation()}
        className="border-line bg-surface max-h-[92vh] w-full overflow-y-auto rounded-t-[var(--radius)] border p-4 shadow-2xl sm:max-w-lg sm:rounded-[var(--radius)]"
      >
        {isPending || !preview ? (
          <p className="text-muted py-8 text-center text-sm">Cargando la tarea…</p>
        ) : (
          <>
            <header className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 id="entrega-title" className="font-display text-lg leading-tight font-semibold">
                  {preview.assignment.name}
                </h2>
                <p className="text-muted mt-1 text-xs">
                  {preview.assignment.dueAt ? `Vence ${whenLabel(preview.assignment.dueAt)}` : 'Sin fecha de entrega'}
                  {preview.drafts ? ' · con etapa de borrador' : ' · sin etapa de borrador'}
                </p>
              </div>
              <button type="button" onClick={onClose} className="text-muted hover:text-fg -mt-1 -mr-1 p-2" aria-label="Cerrar">
                <X className="size-5" aria-hidden />
              </button>
            </header>

            {hecho ? (
              <>
                <Aviso tono="bien">
                  {hecho.sent
                    ? 'Salió. mikampus volvió a preguntarle a la PVA por el estado real de la entrega.'
                    : 'No se mandó nada.'}
                </Aviso>
                {hecho.warnings.map((aviso) => (
                  <Aviso key={aviso} tono="ojo">
                    {aviso}
                  </Aviso>
                ))}
                <button
                  type="button"
                  onClick={onClose}
                  className="border-line hover:bg-surface-2 mt-3 min-h-11 w-full rounded-full border text-sm font-medium"
                >
                  Cerrar
                </button>
              </>
            ) : ensayo ? (
              // ── Paso 2: lo que va a viajar, y recién ahí la confirmación ──
              <>
                <p className="text-muted mt-3 text-[10px] font-semibold tracking-wide uppercase">Esto es lo que va a viajar</p>
                <div className="bg-bg mt-1 rounded-[var(--radius)] p-3 font-mono text-[11px] leading-relaxed">
                  {ensayo.sends.onlineText && (
                    <p className="text-muted break-words">
                      <span className="text-fg font-semibold">onlinetext</span> {ensayo.sends.onlineText.slice(0, 220)}
                      {ensayo.sends.onlineText.length > 220 ? '…' : ''}
                    </p>
                  )}
                  {ensayo.sends.files.map((file) => (
                    <p key={file.name} className="text-muted break-words">
                      <span className="text-fg font-semibold">archivo</span> {file.name} · {tamano(file.bytes)} ·{' '}
                      {file.mimetype ?? 'tipo sin declarar'}
                    </p>
                  ))}
                  <p className="text-muted">
                    <span className="text-fg font-semibold">función</span> mod_assign_save_submission
                  </p>
                </div>
                <Aviso tono="bien">Ensayo asentado. No salió nada de esta máquina.</Aviso>
                {!preview.drafts && (
                  <Aviso tono="alto">Esta tarea no tiene etapa de borrador: al mandar, el profesor ya lo ve.</Aviso>
                )}
                {ensayo.warnings.map((aviso) => (
                  <Aviso key={aviso} tono="ojo">
                    {aviso}
                  </Aviso>
                ))}

                {preview.requiresConfirmation && (
                  <>
                    <label htmlFor="confirmar" className="text-muted mt-3 block text-[10px] font-semibold tracking-wide uppercase">
                      Escribí el nombre de la tarea
                    </label>
                    <input
                      id="confirmar"
                      value={nombre}
                      onChange={(event) => setNombre(event.target.value)}
                      placeholder={preview.assignment.name}
                      className="border-accent bg-bg focus-visible:outline-accent mt-1 min-h-11 w-full rounded-[var(--radius)] border px-3 text-sm focus-visible:outline-2"
                    />
                  </>
                )}
                {error && <p className="text-closed mt-2 text-xs">{error}</p>}

                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setEnsayo(null)}
                    className="border-line hover:bg-surface-2 min-h-11 rounded-full border text-sm font-medium"
                  >
                    Volver
                  </button>
                  <button
                    type="button"
                    disabled={trabajando || (preview.requiresConfirmation && nombre.trim().length === 0)}
                    onClick={() => mandar.mutate()}
                    className="bg-closed min-h-11 rounded-full text-sm font-semibold text-white disabled:opacity-40"
                  >
                    {trabajando ? 'Mandando…' : preview.drafts ? 'Guardar borrador' : 'Entregar'}
                  </button>
                </div>
              </>
            ) : (
              // ── Paso 1: qué se manda ──
              <>
                {preview.blockers.map((motivo) => (
                  <Aviso key={motivo} tono="alto">
                    {motivo}
                  </Aviso>
                ))}
                {preview.warnings.map((aviso) => (
                  <Aviso key={aviso} tono="ojo">
                    {aviso}
                  </Aviso>
                ))}
                {yaEntregada && <Aviso tono="bien">Ya está entregada.</Aviso>}

                {preview.limits.onlineText.enabled && (
                  <>
                    <label htmlFor="texto" className="text-muted mt-3 block text-[10px] font-semibold tracking-wide uppercase">
                      Tu respuesta
                    </label>
                    <textarea
                      id="texto"
                      rows={5}
                      value={texto}
                      onChange={(event) => setTexto(event.target.value)}
                      className="border-line bg-bg focus-visible:outline-accent mt-1 w-full rounded-[var(--radius)] border px-3 py-2 text-sm leading-relaxed focus-visible:outline-2"
                    />
                    {preview.limits.onlineText.wordLimit > 0 && (
                      <p className="text-muted mt-1 text-xs">Máximo {preview.limits.onlineText.wordLimit} palabras.</p>
                    )}
                  </>
                )}

                {preview.limits.file.enabled && (
                  <>
                    <p className="text-muted mt-3 text-[10px] font-semibold tracking-wide uppercase">Archivos</p>
                    <label className="border-line hover:bg-surface-2 mt-1 flex min-h-11 cursor-pointer items-center gap-2 rounded-[var(--radius)] border border-dashed px-3 text-sm">
                      <Paperclip className="text-muted size-4" aria-hidden />
                      Elegir archivo
                      <input
                        type="file"
                        multiple={preview.limits.file.maxFiles > 1}
                        className="sr-only"
                        onChange={async (event) => {
                          const elegidos = [...(event.target.files ?? [])];
                          setArchivos([...archivos, ...(await Promise.all(elegidos.map(leerArchivo)))]);
                          event.target.value = '';
                        }}
                      />
                    </label>
                    {archivos.map((file, indice) => (
                      <div key={file.name} className="border-line mt-1 flex min-h-10 items-center gap-2 rounded-[var(--radius)] border px-3 text-sm">
                        <span className="flex-1 truncate">{file.name}</span>
                        <button
                          type="button"
                          onClick={() => setArchivos(archivos.filter((_, otro) => otro !== indice))}
                          className="text-muted hover:text-fg p-1"
                          aria-label={`Quitar ${file.name}`}
                        >
                          <X className="size-4" aria-hidden />
                        </button>
                      </div>
                    ))}
                    <p className="text-muted mt-1 text-xs">
                      {preview.limits.file.maxFiles} archivo(s) como máximo
                      {preview.limits.file.maxBytes > 0 ? `, ${tamano(preview.limits.file.maxBytes)} cada uno` : ''}
                      {preview.limits.file.types.length ? `, solo ${preview.limits.file.types.join(', ')}` : ''}.
                    </p>
                  </>
                )}

                {error && <p className="text-closed mt-2 text-xs">{error}</p>}

                <button
                  type="button"
                  disabled={!hayAlgo || trabajando || preview.blockers.length > 0}
                  onClick={() => ver.mutate()}
                  className="bg-accent text-accent-fg mt-3 min-h-11 w-full rounded-full text-sm font-semibold disabled:opacity-40"
                >
                  {ver.isPending ? 'Preparando…' : 'Ver qué va a viajar'}
                </button>

                {/* Solo donde la tarea sí tiene borrador: ahí "entregar" es un
                    paso real y distinto de guardar. */}
                {preview.drafts && enBorrador && (
                  <div className="border-line mt-3 border-t pt-3">
                    <p className="text-sm font-medium">Tenés un borrador guardado.</p>
                    <p className="text-muted mt-1 text-xs">Entregarlo en firme lo cierra: el profesor tendría que reabrirlo.</p>
                    {preview.requiresStatement && (
                      <label className="mt-2 flex items-start gap-2 text-xs">
                        <input type="checkbox" checked={acepta} onChange={(event) => setAcepta(event.target.checked)} className="mt-0.5" />
                        <span>{preview.statement}</span>
                      </label>
                    )}
                    <input
                      value={nombre}
                      onChange={(event) => setNombre(event.target.value)}
                      placeholder={preview.assignment.name}
                      aria-label="Escribí el nombre de la tarea para entregar"
                      className="border-accent bg-bg mt-2 min-h-11 w-full rounded-[var(--radius)] border px-3 text-sm"
                    />
                    <button
                      type="button"
                      disabled={trabajando || nombre.trim().length === 0}
                      onClick={() => enFirme.mutate()}
                      className="bg-closed mt-2 min-h-11 w-full rounded-full text-sm font-semibold text-white disabled:opacity-40"
                    >
                      Entregar en firme
                    </button>
                  </div>
                )}

                {url && (
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-muted hover:text-fg mt-3 flex min-h-8 items-center justify-center gap-1.5 text-xs"
                  >
                    Abrir la tarea en la PVA
                    <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                )}
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
