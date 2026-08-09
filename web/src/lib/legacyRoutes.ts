// Los caminos viejos de planificación, mapeados al workspace unificado (P2).
//
// /planear, /planner y /builder existieron como secciones propias y hay
// bookmarks, notas y enlaces viejos apuntando ahí. Fusionar Planear dentro de
// Inscripción no puede convertir esos enlaces en un 404 ni, peor, tirarlos al
// inicio perdiendo el plan que traían: el redirect conserva la etapa
// equivalente y el plan abierto.
//
// Vive como función pura y no dentro del componente para poder probarla sin
// montar un router.

export type Stage = 'plan' | 'grupos' | 'carrito';

export function isStage(value: string | null | undefined): value is Stage {
  return value === 'plan' || value === 'grupos' || value === 'carrito';
}

/**
 * A dónde manda un camino viejo.
 *
 * @param pathname  '/planear' | '/planner' | '/builder'
 * @param search    la query original ('?tab=horario&plan=7' o URLSearchParams)
 */
export function legacyPlanTarget(pathname: string, search: string | URLSearchParams = ''): string {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;

  // /planner y /builder nombraban la etapa en la ruta; /planear la llevaba en
  // ?tab. `materias` y cualquier otra cosa caen en la primera etapa, que es el
  // default correcto: es donde empieza el recorrido.
  const stage: Stage =
    pathname === '/builder' ? 'grupos' : pathname === '/planner' ? 'plan' : params.get('tab') === 'horario' ? 'grupos' : 'plan';

  const next = new URLSearchParams();
  // 'plan' es el default de /inscripcion: no se escribe en la URL para no
  // ensuciar el enlace que la persona va a ver y compartir.
  if (stage !== 'plan') next.set('etapa', stage);

  const planId = params.get('plan');
  if (planId) next.set('plan', planId);

  // El ciclo no existía en las rutas viejas, pero si alguien lo agregó a mano
  // se respeta: es el contexto del que cuelga todo lo demás.
  const term = params.get('ciclo');
  if (term) next.set('ciclo', term);

  const query = next.toString();
  return `/inscripcion${query ? `?${query}` : ''}`;
}
