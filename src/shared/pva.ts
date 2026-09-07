// Derivaciones puras de la PVA. Viven acá porque las necesitan los dos lados y
// ninguno puede importar al otro: el sync escribe con la conexión de src/db.js
// y el servidor MCP abre la base en solo lectura. Compartir el cálculo es lo
// que impide que la app y el agente contesten cosas distintas sobre la misma
// tarea; compartir el SQL sería darle escritura al MCP.

export interface SubmissionFacts {
  /** Epoch en segundos, o null cuando Moodle mandó su centinela 0. */
  duedate: number | null;
  cutoffdate: number | null;
  /** Prórroga de esta persona: manda sobre las dos de arriba. */
  extensionAt: number | null;
  /** 1 cuando la tarea tiene etapa de borrador que hay que confirmar. */
  submissionDrafts: number;
  status: string | null;
  submittedAt: number | null;
  /** Lo dice el servidor. No se recalcula desde las fechas. */
  canEdit: boolean;
  gradingStatus: string | null;
  nowSeconds: number;
}

export interface SubmissionState {
  submitted: boolean;
  graded: boolean;
  canEdit: boolean;
  needsConfirmation: boolean;
  isLate: boolean;
  isOverdue: boolean;
  closesAt: number | null;
  acceptsLate: boolean;
  closedForever: boolean;
}

/**
 * El estado que ve el estudiante no es un campo de la respuesta: se deriva de
 * seis, y la editabilidad tampoco es un solo booleano.
 *
 * Las dos trampas que resuelve, verificadas en el recon:
 *
 *   * `cutoffdate` ausente significa que se acepta tarde INDEFINIDAMENTE, y
 *     `cutoffdate` igual a `duedate` significa que no se acepta nada tarde. Son
 *     los dos extremos y se distinguen solo por el centinela.
 *   * `cansubmit` fue false en las tres respuestas del volcado, incluso en las
 *     tareas editables: con `submissiondrafts = 0` no hay paso de confirmación
 *     y un botón atado a ese campo no se habilita nunca. Manda `canedit`.
 */
export function submissionState(facts: SubmissionFacts): SubmissionState {
  const deadline = facts.extensionAt ?? facts.duedate ?? null;
  const closesAt = facts.extensionAt ?? facts.cutoffdate ?? facts.duedate ?? null;
  const submitted = facts.status === 'submitted';
  return {
    submitted,
    graded: facts.gradingStatus === 'graded',
    canEdit: facts.canEdit,
    needsConfirmation: facts.submissionDrafts === 1,
    isLate: Boolean(submitted && deadline && facts.submittedAt && facts.submittedAt > deadline),
    isOverdue: Boolean(!submitted && deadline && deadline < facts.nowSeconds),
    closesAt,
    acceptsLate: facts.cutoffdate == null,
    closedForever: Boolean(facts.cutoffdate && facts.cutoffdate < facts.nowSeconds),
  };
}

/**
 * Cómo se pinta la finalización de un módulo. El estado solo existe cuando el
 * módulo tiene seguimiento, y eso depende del módulo y no del curso: un curso
 * con `enablecompletion` puede traer cero módulos con seguimiento.
 */
export function completionLabel(rule: number, state: number | null): 'sin_seguimiento' | 'pendiente' | 'hecho' {
  if (rule !== 1) return 'sin_seguimiento';
  return state === 1 ? 'hecho' : 'pendiente';
}
