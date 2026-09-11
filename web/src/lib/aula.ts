import type { AulaCourseCard, AulaFeedItem as FeedItem, AulaModule } from '../../../src/shared/schemas.ts';

// Las etiquetas de la pantalla Aula, aparte del render: son decisiones de qué
// se le dice al estudiante, y así se pueden verificar sin montar React.

export type AulaFeedItem = FeedItem;

const MS_DIA = 86_400_000;
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

/**
 * Cuándo, en la forma más corta que sigue siendo exacta. Una entrega de hoy se
 * dice con su hora; una de la semana que viene, con su día. "En 3 días" obliga
 * a hacer la cuenta para saber si es antes o después de la clase del jueves.
 */
export function whenLabel(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const hora = `${at.getHours() % 12 === 0 ? 12 : at.getHours() % 12}:${String(at.getMinutes()).padStart(2, '0')}${at.getHours() < 12 ? 'a' : 'p'}`;
  const dia = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const hoy = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dias = Math.round((dia - hoy) / MS_DIA);
  // "11:59p" a secas se lee ambiguo en una tarjeta: la hora sin día obliga a
  // suponer cuál día es.
  if (dias === 0) return `hoy ${hora}`;
  if (dias === 1) return `mañana ${hora}`;
  if (dias === -1) return 'ayer';
  if (dias > 1 && dias < 7) return `${DIAS[at.getDay()]} ${hora}`;
  // Hacia atrás el nombre del día se lee como el próximo: "mié" para algo
  // que venció el miércoles pasado es la misma trampa que la hora sin día.
  return `${at.getDate()}/${at.getMonth() + 1}`;
}

/**
 * Qué dice una fila del feed y con qué tono. El tono no es decoración: separa
 * lo que hay que hacer de lo que ya pasó, que es la única jerarquía que la
 * pantalla necesita.
 */
export function feedLabel(item: AulaFeedItem): { texto: string; tono: 'urgente' | 'pendiente' | 'hecho' } {
  if (item.kind === 'vence') {
    // null no es false: no se consultó el estado, y decir "sin entregar" ahí
    // sería afirmar algo que nadie preguntó.
    if (item.submitted === true) return { texto: 'Entregada', tono: 'hecho' };
    if (item.submitted === null) return { texto: 'Estado sin consultar', tono: 'pendiente' };
    return { texto: 'Sin entregar', tono: 'urgente' };
  }
  if (item.kind === 'nota_publicada') return { texto: 'Nota publicada', tono: 'hecho' };
  if (item.kind === 'anuncio') return { texto: 'Anuncio del profesor', tono: 'pendiente' };
  if (item.kind === 'tarea_nueva') return { texto: 'Tarea nueva', tono: 'pendiente' };
  return { texto: item.detail ?? '', tono: 'pendiente' };
}

const ENTIDADES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', ndash: '-', mdash: '-' };

/**
 * Moodle formatea las notas para HTML: "85,00&nbsp;/&nbsp;100,00" llega tal
 * cual desde el web service, y pintarla sin decodificar le muestra la entidad
 * al estudiante.
 */
export function decodeGrade(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTIDADES[name.toLowerCase()] ?? match)
    .trim();
}

/**
 * El libro de una materia en una línea. Son cuatro estados y ninguno es un
 * cero: oculto por el profesor, nunca consultado, consultado y sin nota, y con
 * nota. Los tres primeros se confunden en cuanto se escribe un guion.
 */
export function gradeLabel(grade: AulaCourseCard['grade']): string {
  if (grade.hidden) return 'Libro oculto por el profesor';
  if (!grade.checked) return 'Todavía no se consultó el libro de esta materia';
  if (!grade.total) return 'Sin nota publicada todavía';
  return `Nota del aula ${decodeGrade(grade.total)} · ${grade.gradedItems} de ${grade.gradableItems} items calificados`;
}

const TIPOS: Record<string, string> = {
  assign: 'Tarea',
  resource: 'Archivo',
  url: 'Enlace',
  page: 'Página',
  folder: 'Carpeta',
  forum: 'Foro',
  label: 'Texto',
  quiz: 'Cuestionario',
  glossary: 'Glosario',
};

/** El tipo de un módulo en palabras, con una salida honesta para lo desconocido. */
export function moduleKind(modname: string): string {
  return TIPOS[modname] ?? modname;
}

/**
 * La segunda línea de un módulo: lo que hace falta saber sin abrirlo. Para una
 * tarea, su estado; para un archivo, si se puede buscar por dentro; para un
 * enlace, a dónde lleva.
 */
export function moduleMeta(module: AulaModule): string {
  if (module.assignment) {
    const { submitted, graded, gradeText, isLate, isOverdue } = module.assignment;
    if (graded) return `Calificada${gradeText ? ` · ${decodeGrade(gradeText)}` : ''}`;
    if (submitted === true) return isLate ? 'Entregada tarde · sin calificar' : 'Entregada · sin calificar';
    if (submitted === null) return 'Estado sin consultar';
    return isOverdue ? 'Venció y no está entregada' : 'Sin entregar';
  }
  if (module.links.length) return `Enlace externo · ${module.links[0].host}`;
  if (module.files.length) {
    const indexados = module.files.filter((file) => file.indexed).length;
    const sinBajar = module.files.filter((file) => !file.downloaded).length;
    const cuantos = module.files.length === 1 ? '' : `${module.files.length} archivos · `;
    if (sinBajar) return `${cuantos}sin bajar todavía`;
    return `${cuantos}${indexados ? 'se puede buscar por dentro' : 'bajado, sin texto que buscar'}`;
  }
  return moduleKind(module.modname);
}
