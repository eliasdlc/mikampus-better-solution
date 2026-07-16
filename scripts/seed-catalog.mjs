// Siembra un catálogo pequeño pero realista para desarrollar y verificar la UI,
// la búsqueda MiniSearch y el endpoint sin golpear el portal. NO es data real:
// estas materias no existen. Para llenar el catálogo de verdad es
// scripts/sync-catalog.mjs.
//
// Exige MIKAMPUS_DB: sembrado contra la base real, estas 4 materias inventadas
// salían en la búsqueda mezcladas con las reales y no había cómo distinguirlas
// a simple vista.
//
//   MIKAMPUS_DB=/tmp/ui.db node scripts/seed-catalog.mjs
if (!process.env.MIKAMPUS_DB) {
  console.error(
    'seed-catalog siembra materias INVENTADAS y solo corre contra una base desechable.\n' +
      'Usá:  MIKAMPUS_DB=/tmp/ui.db node scripts/seed-catalog.mjs\n' +
      'Para el catálogo real:  node scripts/sync-catalog.mjs ICC'
  );
  process.exit(1);
}

const { saveSection } = await import('../src/peoplesoft/catalog.js');
const { scrapedSectionSchema } = await import('../src/shared/schemas.ts');

// Los días van con el código de dos letras de PeopleSoft (Mo/Tu/We…), igual
// que lo que entrega el scraper real — si el seed usara otro formato, el
// WeeklyGrid se vería bien con data sembrada y roto con data real.
const TERM = '2470';
const seed = [
  { code: 'ICC-303', subject: 'ICC', nbr: '303', title: 'Estructuras de Datos', credits: 4, secs: [
    { nbr: '4567', section: '101', component: 'LEC', instr: 'Pérez, Juan', days: ['Mo', 'We'], start: '09:00', end: '10:30', room: 'A-201', status: 'open', open: 5, cap: 30 },
    { nbr: '4568', section: '102', component: 'LEC', instr: 'Gómez, Ana', days: ['Tu', 'Th'], start: '11:00', end: '12:30', room: 'A-203', status: 'closed', open: 0, cap: 30 },
  ] },
  { code: 'ICC-411', subject: 'ICC', nbr: '411', title: 'Bases de Datos', credits: 4, secs: [
    { nbr: '5001', section: '101', component: 'LEC', instr: 'Reyes, Carla', days: ['Mo', 'We'], start: '14:00', end: '15:30', room: 'B-105', status: 'waitlist', open: 0, cap: 25, wait: 3 },
  ] },
  { code: 'MAT-241', subject: 'MAT', nbr: '241', title: 'Cálculo Vectorial', credits: 5, secs: [
    { nbr: '6100', section: '101', component: 'LEC', instr: 'Santos, Luis', days: ['Tu', 'Th', 'Fr'], start: '07:00', end: '08:30', room: 'C-010', status: 'open', open: 12, cap: 40 },
  ] },
  { code: 'FIS-201', subject: 'FIS', nbr: '201', title: 'Física Mecánica', credits: 4, secs: [
    { nbr: '6200', section: '101', component: 'LEC', instr: 'Núñez, María', days: ['Mo', 'We'], start: '10:00', end: '11:30', room: 'C-110', status: 'open', open: 8, cap: 35 },
  ] },
];

let total = 0;
for (const c of seed) {
  for (const s of c.secs) {
    const data = scrapedSectionSchema.parse({
      courseCode: c.code, subject: c.subject, catalogNbr: c.nbr, title: c.title, career: 'GRDO', credits: c.credits,
      term: TERM, classNbr: s.nbr, section: s.section, component: s.component, instructor: s.instr,
      meetings: [{ days: s.days, start: s.start, end: s.end, room: s.room }],
      seats: { status: s.status, open: s.open, capacity: s.cap, waitTotal: s.wait ?? 0 },
    });
    saveSection(data);
    total++;
  }
}
console.log(`Sembradas ${total} secciones para el término ${TERM}.`);
