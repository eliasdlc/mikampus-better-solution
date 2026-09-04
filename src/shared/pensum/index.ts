import type { PensumPlan } from '../pensumRules.ts';
import icc2020 from './icc-2020.json' with { type: 'json' };

// Los planes académicos que la app trae de fábrica. Se generan con
// scripts/sync-pensum-rules.mjs y se versionan a propósito: el PDF oficial vive
// en el OneDrive personal de un docente, así que si ese enlace muere la app
// tiene que seguir sabiendo el pénsum — solo pierde la capacidad de refrescarlo.

const PLANS: Record<string, PensumPlan> = {
  'ICC-2020': icc2020 as unknown as PensumPlan,
};

/**
 * El plan de un estudiante a partir de su perfil del portal, que trae el número
 * de pénsum ("2020") y la carrera. El informe de avance nombra los bloques
 * "ICC-2020 Año N Período M", así que el prefijo del plan sale de ahí.
 *
 * Devuelve null cuando el plan no está en la app: eso NO es un error, es el
 * caso normal de cualquier carrera que todavía no se haya sincronizado. Todo
 * el motor de elegibilidad trata `null` como "sin reglas conocidas" y no
 * bloquea nada.
 */
export function planFor({
  planCode,
  pensumNo,
  career,
}: {
  planCode?: string | null;
  pensumNo?: string | null;
  career?: string | null;
}): PensumPlan | null {
  if (planCode && PLANS[planCode.toUpperCase()]) return PLANS[planCode.toUpperCase()];

  if (pensumNo) {
    // "INGENIERÍA EN CIENCIAS DE LA COMPUTACIÓN" + "2020" → ICC-2020. Se busca
    // por coincidencia de carrera y número, no por una tabla de siglas: la
    // carrera viene tal cual la escribe el portal y ya está en cada plan.
    const wanted = String(pensumNo).trim();
    for (const [code, plan] of Object.entries(PLANS)) {
      if (!code.endsWith(`-${wanted}`)) continue;
      if (!career || !plan.career) return plan;
      if (normalize(plan.career) === normalize(career)) return plan;
    }
  }
  return null;
}

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

export function knownPlans(): string[] {
  return Object.keys(PLANS);
}
