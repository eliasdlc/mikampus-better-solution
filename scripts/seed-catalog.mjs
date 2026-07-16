// Siembra un catálogo pequeño pero realista para desarrollar y verificar la UI,
// la búsqueda MiniSearch y el endpoint sin golpear el portal. NO es data real:
// se reemplaza en cuanto corra el scraper de verdad contra un término.
import { saveSection } from '../src/peoplesoft/catalog.js';
import { scrapedSectionSchema } from '../src/shared/schemas.ts';

const TERM = '2470';
const seed = [
  { code: 'ICC-303', subject: 'ICC', nbr: '303', title: 'Estructuras de Datos', credits: 4, secs: [
    { nbr: '4567', section: '01-LEC', instr: 'Pérez, Juan', days: ['Lu', 'Mi'], start: '09:00', end: '10:30', room: 'A-201', status: 'open', open: 5, cap: 30 },
    { nbr: '4568', section: '02-LEC', instr: 'Gómez, Ana', days: ['Ma', 'Ju'], start: '11:00', end: '12:30', room: 'A-203', status: 'closed', open: 0, cap: 30 },
  ] },
  { code: 'ICC-411', subject: 'ICC', nbr: '411', title: 'Bases de Datos', credits: 4, secs: [
    { nbr: '5001', section: '01-LEC', instr: 'Reyes, Carla', days: ['Lu', 'Mi'], start: '14:00', end: '15:30', room: 'B-105', status: 'waitlist', open: 0, cap: 25, wait: 3 },
  ] },
  { code: 'MAT-241', subject: 'MAT', nbr: '241', title: 'Cálculo Vectorial', credits: 5, secs: [
    { nbr: '6100', section: '01-LEC', instr: 'Santos, Luis', days: ['Ma', 'Ju', 'Vi'], start: '07:00', end: '08:30', room: 'C-010', status: 'open', open: 12, cap: 40 },
  ] },
  { code: 'FIS-201', subject: 'FIS', nbr: '201', title: 'Física Mecánica', credits: 4, secs: [
    { nbr: '6200', section: '01-LEC', instr: 'Núñez, María', days: ['Lu', 'Mi'], start: '10:00', end: '11:30', room: 'C-110', status: 'open', open: 8, cap: 35 },
  ] },
];

let total = 0;
for (const c of seed) {
  for (const s of c.secs) {
    const data = scrapedSectionSchema.parse({
      courseCode: c.code, subject: c.subject, catalogNbr: c.nbr, title: c.title, career: 'GRDO', credits: c.credits,
      term: TERM, classNbr: s.nbr, section: s.section, component: 'LEC', instructor: s.instr,
      meetings: [{ days: s.days, start: s.start, end: s.end, room: s.room }],
      seats: { status: s.status, open: s.open, capacity: s.cap, waitTotal: s.wait ?? 0 },
    });
    saveSection(data);
    total++;
  }
}
console.log(`Sembradas ${total} secciones para el término ${TERM}.`);
