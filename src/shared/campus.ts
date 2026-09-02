import { z } from 'zod';

// El vocabulario de campus, tal como lo nombra el propio portal. El código es
// el `value` del <select name="SSR_CLSRCH_WRK_CAMPUS$0"> del class search y la
// etiqueta es su texto literal, que es también lo que el carrito escribe en
// CAMPUS_TBL_DESCR. Guardar el código y no el texto es lo que evita que dos
// pantallas del portal terminen escribiendo dos vocabularios distintos en la
// misma columna.
export const CAMPUS_CODES = ['CSTI', 'CSTA', 'CVIR'] as const;
export type CampusCode = (typeof CAMPUS_CODES)[number];
export const campusCodeSchema = z.enum(CAMPUS_CODES);

export const CAMPUS_LABELS = {
  CSTI: 'Campus Santiago',
  CSTA: 'Campus Santo Domingo',
  CVIR: 'Campus Virtual',
} as const satisfies Record<CampusCode, string>;

// De la etiqueta del portal a su código. La comparación es exacta a propósito:
// el día que PUCMM renombre un campus esto devuelve null y el dato queda
// explícitamente ausente, en vez de que una coincidencia difusa decida sola a
// qué campus pertenece una sección.
export function campusFromLabel(label: string | null | undefined): CampusCode | null {
  if (!label) return null;
  return CAMPUS_CODES.find((code) => CAMPUS_LABELS[code] === label) ?? null;
}

// De dónde salió el campus de una sección. 'portal' es un dato que el portal
// dijo (el filtro de campus con que se pidió la búsqueda, o la etiqueta del
// carrito); 'seccion' es la inferencia por el primer dígito del número de
// sección, que es una convención del registrador y no un contrato publicado.
// La columna existe para que una inferencia nunca se pueda leer como verdad:
// campus no se expone en ninguna capa sin su procedencia al lado.
export const CAMPUS_SOURCES = ['portal', 'seccion'] as const;
export type CampusSource = (typeof CAMPUS_SOURCES)[number];
export const campusSourceSchema = z.enum(CAMPUS_SOURCES);

// La etiqueta de un grupo de secciones cuyo campus nadie pudo atribuir. No es
// un cuarto campus: es la ausencia del dato dicha con todas las letras, para
// que una sección desconocida nunca se muestre como si fuera del tuyo.
export const UNKNOWN_CAMPUS_LABEL = 'Campus sin confirmar';

// El nombre con que se muestra un campus, incluida su ausencia.
export function campusLabel(campus: CampusCode | null): string {
  return campus ? CAMPUS_LABELS[campus] : UNKNOWN_CAMPUS_LABEL;
}

// El primer dígito del número de sección y el campus que implica. Verificado
// contra el propio portal: cuando el barrido tuvo que partir una búsqueda por
// campus, CSTI devolvió únicamente secciones 1xx y CSTA únicamente 2xx, en
// tandas repetidas y sin un contraejemplo. Es una convención del registrador de
// PUCMM, no un contrato publicado, así que lo que sale de acá se marca siempre
// como campus_source 'seccion' y jamás se confunde con lo que dijo el portal.
// Los demás prefijos (0xx, 8xx) no tienen evidencia y no se infieren: la única
// sección 030 atribuida volvió en la búsqueda de Santo Domingo, no en la de
// Virtual, así que "0xx es Virtual" sería inventar.
export const CAMPUS_BY_SECTION_PREFIX = {
  '1': 'CSTI',
  '2': 'CSTA',
} as const satisfies Record<string, CampusCode>;

export function campusFromSectionNumber(section: string | null | undefined): CampusCode | null {
  const first = section?.trim()[0];
  if (!first) return null;
  return first in CAMPUS_BY_SECTION_PREFIX
    ? CAMPUS_BY_SECTION_PREFIX[first as keyof typeof CAMPUS_BY_SECTION_PREFIX]
    : null;
}

// El orden canónico de campus, y por qué es este:
//
//   0. el campus del estudiante, porque es donde puede estar en persona;
//   1. el otro campus presencial, que es una opción legítima (nadie la esconde)
//      pero no la primera;
//   2. el campus sin confirmar, que va después de lo conocido pero ANTES de lo
//      virtual: no sabemos qué es, y adivinar su lugar sería afirmar algo;
//   3. Campus Virtual, que no compite con los presenciales por ubicación.
//
// Sin campus elegido en el perfil no hay "primero": los presenciales quedan
// empatados y el orden lo decide el desempate estable de quien llama (número de
// sección), que no privilegia a ninguno.
export function campusRank(campus: CampusCode | null, homeCampus: CampusCode | null): number {
  if (homeCampus && campus === homeCampus) return 0;
  if (campus === null) return 2;
  if (campus === 'CVIR') return 3;
  return 1;
}

// Ordena una lista ya ordenada por su criterio propio (número de sección) para
// que el campus mande sobre ese criterio sin romperlo: Array.prototype.sort es
// estable, así que dentro de un mismo campus el orden de entrada se conserva.
export function orderByCampus<T extends { campus: CampusCode | null }>(
  items: readonly T[],
  homeCampus: CampusCode | null
): T[] {
  return [...items].sort((a, b) => campusRank(a.campus, homeCampus) - campusRank(b.campus, homeCampus));
}

export type CampusGroup<T> = {
  campus: CampusCode | null;
  label: string;
  isHome: boolean;
  items: T[];
};

// Parte una lista de secciones en grupos por campus, en el orden canónico. El
// backend lo entrega resuelto para que ninguna pantalla tenga que reimplementar
// la regla, y al lado va la lista plana con el campo crudo por si una pantalla
// quiere presentarlo de otra forma. Una materia con secciones de un solo campus
// devuelve un solo grupo: es la UI la que decide si un grupo único merece
// encabezado (no lo merece: sería ruido).
export function groupByCampus<T extends { campus: CampusCode | null }>(
  items: readonly T[],
  homeCampus: CampusCode | null
): CampusGroup<T>[] {
  const groups = new Map<CampusCode | null, CampusGroup<T>>();
  for (const item of orderByCampus(items, homeCampus)) {
    let group = groups.get(item.campus);
    if (!group) {
      group = {
        campus: item.campus,
        label: campusLabel(item.campus),
        isHome: homeCampus !== null && item.campus === homeCampus,
        items: [],
      };
      groups.set(item.campus, group);
    }
    group.items.push(item);
  }
  return [...groups.values()];
}
