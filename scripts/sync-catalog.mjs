import 'dotenv/config';
import { loginToPeopleSoft } from '../src/login.js';
import { fetchSubjects, syncSubjectTitles, knownSubjects } from '../src/peoplesoft/browseCatalog.js';
import { syncCatalogSubject } from '../src/peoplesoft/catalog.js';
import { fetchAdvisement, savePensum } from '../src/peoplesoft/advisement.js';

// Llena el catálogo real desde el portal. Es el eslabón que faltaba: el scraper
// existía y estaba probado, pero nadie lo llamaba, así que la app buscaba
// contra una base con datos de mentira.
//
// Dos pantallas, en este orden, porque la segunda depende de la primera:
//
//   1. Browse Catalog → la lista de subjects y el título de cada materia.
//      Los subjects van primero porque partir "ICC223" en ICC + 223 necesita
//      saber qué prefijos son subjects reales (shared/courseCode.ts).
//   2. Class Search → las secciones, horarios y cupos de un término.
//
// Es lento a propósito: cada navegación de PeopleSoft ronda los 20s y hay un
// throttle entre pedidos. Corre a mano o de fondo, nunca colgando de la UI.
//
//   node scripts/sync-catalog.mjs ICC MAT              # títulos + secciones
//   node scripts/sync-catalog.mjs --pensum             # los subjects de tu pensum
//   node scripts/sync-catalog.mjs --pensum --pendientes  # solo lo que te falta
//   node scripts/sync-catalog.mjs --subjects           # solo refrescar la lista
//   SYNC_TERM=1930 node scripts/sync-catalog.mjs ICC

const TERM = process.env.SYNC_TERM || process.env.TARGET_TERM || '1930';
const CAREER = process.env.SYNC_CAREER || 'GRDO';

const args = process.argv.slice(2);
const onlySubjects = args.includes('--subjects');
const fromPensum = args.includes('--pensum');
const soloPendientes = args.includes('--pendientes');
let requested = args.filter((a) => !a.startsWith('--')).map((s) => s.toUpperCase());

const { browser, page } = await loginToPeopleSoft({ headless: true });
try {
  // La lista de subjects se refresca si la piden o si nunca se cargó.
  if (onlySubjects || knownSubjects().length === 0) {
    console.log('Leyendo la lista de subjects del Browse Catalog (26 pestañas, ~3 min)...');
    const subjects = await fetchSubjects(page);
    console.log(`✓ ${subjects.length} subjects: ${subjects.map((s) => s.code).join(', ')}`);
  }
  if (onlySubjects) process.exit(0);

  // --pensum: los subjects salen del advisement report del propio estudiante,
  // no de una lista escrita a mano. Es el punto: si la universidad cambia el
  // plan, renombra una materia o agrega una electiva, el próximo sync lo trae
  // solo. Una lista a mano envejece en silencio.
  if (fromPensum) {
    console.log('Leyendo tu pensum del advisement report...');
    const { courses, subjects, plan } = await fetchAdvisement(page);
    // El informe repite materias entre bloques de requisito: lo guardado son
    // los códigos únicos, siempre menos que las filas leídas.
    const guardadas = savePensum(courses);
    const pendientes = guardadas.filter((c) => c.status === 'pending');
    console.log(
      `✓ ${plan ?? 'pensum'}: ${guardadas.length} materias (${courses.length} filas en el informe), ${pendientes.length} pendientes`
    );

    // Lo pendiente es lo único que se puede inscribir: barrer los subjects de
    // materias ya aprobadas es gastar navegaciones contra el portal para nada.
    requested = soloPendientes ? [...new Set(pendientes.map((c) => c.subject))].sort() : subjects;
    console.log(`  subjects a sincronizar (${requested.length}): ${requested.join(', ')}`);
  }

  if (requested.length === 0) {
    console.error('Uso: node scripts/sync-catalog.mjs ICC [MAT ...]');
    console.error('     node scripts/sync-catalog.mjs --pensum [--pendientes]   (subjects desde tu pensum)');
    console.error('     node scripts/sync-catalog.mjs --subjects                (solo refrescar la lista)');
    process.exit(1);
  }

  // Un barrido largo (17 subjects ≈ 1h) no se puede perder entero porque el
  // portal falle en el subject 12: cada uno se aísla y lo ya guardado queda.
  const fallidos = [];
  for (const [i, subject] of requested.entries()) {
    console.log(`\n── ${subject} (${i + 1}/${requested.length}) ──`);
    try {
      const { saved: titles } = await syncSubjectTitles(page, { subject });
      console.log(`  títulos: ${titles} materias`);

      // Sin título, la materia igual queda buscable por código: las secciones no
      // dependen del paso anterior, solo se ven mejor con él.
      const { saved, skipped } = await syncCatalogSubject(page, { term: TERM, career: CAREER, subject });
      console.log(`  secciones (término ${TERM}): ${saved}`);
      if (skipped.length) {
        console.warn(`  ⚠ prefijos que siguen excediendo el límite de 50: ${skipped.join(', ')}`);
      }
    } catch (err) {
      console.error(`  ✗ ${subject} falló: ${err.message}`);
      fallidos.push(subject);
    }
  }

  if (fallidos.length) {
    console.error(`\n⚠ fallaron: ${fallidos.join(', ')} — reintentá con: node scripts/sync-catalog.mjs ${fallidos.join(' ')}`);
  } else {
    console.log(`\n✓ ${requested.length} subject(s) sincronizados`);
  }
} finally {
  await browser.close();
}
