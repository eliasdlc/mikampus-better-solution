// El código canónico de una materia ("ICC-223") es la llave que une las dos
// pantallas del portal: el Browse Catalog aporta el título y el Class Search
// las secciones. Si cada una lo derivara a su manera, el join fallaría en
// silencio — de ahí que la regla viva acá y no dentro de cada parser.
//
// Lo que PUCMM mete de verdad en el campo, visto en el catálogo real de ICC:
//
//   ICC223    subject pegado al número (el caso normal)
//   ICCE01    "Electiva de ICC" — el número lleva letras
//   ITE326    "Introducción Sistemas Digitales", listado bajo ICC pero de ITE
//   1ITE326   "Lab. ITE-326" — el dígito de delante es OTRA materia, no una
//             variante: quitarlo fusionaría el lab con su teoría. Por eso el
//             código con dígito se guarda entero ("ITE-1ITE326").
//
// El subject sale del código mismo, nunca del grupo donde apareció: el Class
// Search confirmó "ICC 1ICC473 -" y ITE326 sale bajo ICC, así que el grupo
// miente lo suficiente como para no confiarle la llave. `subjectHint` solo
// desempata cuando el código lo repite de verdad.

export type CourseCode = { subject: string; catalogNbr: string };

// `raw` es el campo tal cual lo pinta el portal (CRSE_NBR del Browse Catalog o
// el catalog_nbr del header del Class Search). `subjectHint` es el subject del
// grupo donde apareció, que manda cuando el propio código lo repite.
export function splitCourseCode(
  raw: string,
  { subjectHint, knownSubjects = [] }: { subjectHint?: string; knownSubjects?: string[] } = {}
): CourseCode | null {
  const body = raw.replace(/\s+/g, '').toUpperCase();
  if (!body) return null;

  // Más largo primero: si existieran "IC" e "ICC", "ICC223" es de ICC.
  const candidates = [
    ...[...knownSubjects].map((s) => s.toUpperCase()).sort((a, b) => b.length - a.length),
    ...(subjectHint ? [subjectHint.toUpperCase()] : []),
  ];
  for (const subject of candidates) {
    if (body.startsWith(subject) && body.length > subject.length) {
      return { subject, catalogNbr: body.slice(subject.length) };
    }
  }

  // El código no empieza por un subject conocido. Las letras de la cabeza lo
  // son igual ("1ITE326" → ITE): derivarlo así y no del hint es lo que hace
  // que las dos pantallas coincidan aunque una todavía no tenga la lista de
  // subjects cargada. Exige un dígito para no tragarse un encabezado.
  const m = body.match(/^(\d*)([A-Z]{2,4})(?=[A-Z0-9]*\d)([A-Z0-9]*)$/);
  if (!m) return null;
  const [, leadingDigits, subject, rest] = m;
  // Con dígito de prefijo el código va entero: "1ITE326" y "ITE326" son
  // materias distintas (el lab y su teoría) y deben quedar en códigos distintos.
  return { subject, catalogNbr: leadingDigits ? body : rest };
}

export function courseCodeToString({ subject, catalogNbr }: CourseCode): string {
  return `${subject}-${catalogNbr}`;
}

// El inverso para hablar con el portal: el campo "Course Number" del class
// search espera el código tal como PUCMM lo escribe ("ICC303"), no el canónico
// ("ICC-303") ni el número pelado ("303" traería ICC303, MAT3031 y cualquier
// otro que lo contenga, con riesgo de pasarse del límite de 50 secciones).
// En los códigos con dígito de delante ("1ITE326") el catalogNbr se guardó
// entero, subject incluido (ver arriba) — ahí no hay nada que anteponer.
export function portalCatalogNbr({ subject, catalogNbr }: CourseCode): string {
  return catalogNbr.includes(subject) ? catalogNbr : `${subject}${catalogNbr}`;
}
