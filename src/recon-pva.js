import fs from 'node:fs/promises';
import path from 'node:path';
import { dataPaths } from './paths.js';

// Recon de la PVA (Moodle de PUCMM, campusvirtual.pucmm.edu.do/moodle).
//
// A diferencia de MiCampus, acá no hay HTML que parsear: el sitio expone los
// Web Services oficiales (enablewebservices=1, enablemobilewebservice=1) y el
// login es usuario/contraseña directo (typeoflogin=1, sin SSO). O sea que el
// mapa que hay que levantar no es de selectores sino de FUNCIONES: cuáles de
// las que necesitamos están habilitadas en el servicio moodle_mobile_app de
// esta instancia, y qué forma real tiene cada respuesta.
//
// Solo lee. Ninguna función de este script escribe en la plataforma.
//
// Privacidad: los volcados crudos van al directorio de datos del usuario,
// nunca al repo. A la consola sale únicamente la FORMA (claves, tipos, largo
// de arrays), jamás un valor. Los fixtures del repo se derivan después, a
// mano y sanitizados, según docs/fixtures-policy.md.
//
// Correr: npm run recon:pva

const BASE = process.env.PVA_URL ?? 'https://campusvirtual.pucmm.edu.do/moodle';
const OUT_DIR = path.join(path.dirname(dataPaths().db), 'recon-pva');

// Todo lo que la integración necesitaría. El recon no asume que existan: las
// contrasta contra la lista que declara core_webservice_get_site_info.
const NEEDED = {
  identidad: ['core_webservice_get_site_info', 'core_user_get_users_by_field', 'tool_mobile_get_config'],
  cursos: [
    'core_enrol_get_users_courses',
    'core_course_get_courses_by_field',
    'core_course_get_contents',
    'core_course_get_updates_since',
    'core_completion_get_activities_completion_status',
  ],
  tareas: [
    'mod_assign_get_assignments',
    'mod_assign_get_submission_status',
    'mod_assign_get_grades',
    'mod_assign_save_submission',
    'mod_assign_submit_for_grading',
  ],
  notas: ['gradereport_user_get_grade_items', 'gradereport_overview_get_course_grades'],
  calendario: ['core_calendar_get_action_events_by_timesort', 'core_calendar_get_calendar_events'],
  foros: [
    'mod_forum_get_forums_by_courses',
    'mod_forum_get_forum_discussions',
    'mod_forum_get_discussion_posts',
    'mod_forum_add_discussion_post',
  ],
  avisos: ['message_popup_get_popup_notifications', 'core_message_get_conversations'],
  archivos: ['core_files_get_files', 'core_user_get_private_files_info'],
  otros: [
    'mod_quiz_get_quizzes_by_courses',
    'mod_quiz_get_user_best_grade',
    'mod_resource_get_resources_by_courses',
    'mod_url_get_urls_by_courses',
    'mod_page_get_pages_by_courses',
    'mod_folder_get_folders_by_courses',
  ],
};

async function credentialsFromEnv() {
  const raw = await fs.readFile(path.join(process.cwd(), '.env'), 'utf8').catch(() => '');
  const env = Object.fromEntries(
    raw
      .split('\n')
      .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
      .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()])
  );
  return {
    username: process.env.PVA_USERNAME ?? env.PUCMM_USERNAME,
    password: process.env.PVA_PASSWORD ?? env.PUCMM_PASSWORD,
  };
}

// El token del servicio móvil no caduca solo: vale hasta que se revoque. Se
// guarda con modo 600 fuera del repo y se trata como una contraseña.
async function getToken() {
  if (process.env.PVA_TOKEN) return process.env.PVA_TOKEN;
  const secretsFile = path.join(process.env.HOME ?? '', '.config', 'secretos', 'pva.env');
  const cached = await fs.readFile(secretsFile, 'utf8').catch(() => '');
  const match = cached.match(/^PVA_TOKEN=(.+)$/m);
  if (match) return match[1].trim();

  const { username, password } = await credentialsFromEnv();
  if (!username || !password) throw new Error('Sin credenciales: definí PVA_USERNAME y PVA_PASSWORD, o PVA_TOKEN');
  const res = await fetch(`${BASE}/login/token.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password, service: 'moodle_mobile_app' }),
  });
  const body = await res.json();
  if (!body.token) throw new Error(`token.php rechazó el login: ${body.errorcode ?? 'sin errorcode'}`);
  await fs.mkdir(path.dirname(secretsFile), { recursive: true });
  await fs.writeFile(secretsFile, `PVA_TOKEN=${body.token}\nPVA_URL=${BASE}\n`, { mode: 0o600 });
  return body.token;
}

// Los parámetros de Moodle viajan aplanados: courseids[0]=5&options[0][name]=x
function flatten(value, prefix, out = new URLSearchParams()) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) flatten(inner, `${prefix}[${key}]`, out);
  } else {
    out.set(prefix, String(value));
  }
  return out;
}

function params(args) {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) flatten(value, key, out);
  return out;
}

async function call(token, wsfunction, args = {}) {
  const body = params(args);
  body.set('wstoken', token);
  body.set('wsfunction', wsfunction);
  body.set('moodlewsrestformat', 'json');
  const res = await fetch(`${BASE}/webservice/rest/server.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (data?.exception) {
    const err = new Error(data.message ?? data.errorcode);
    err.errorcode = data.errorcode;
    throw err;
  }
  return data;
}

// La forma de una respuesta sin un solo valor adentro: claves, tipos y largos.
// Es lo único que puede salir a la consola o terminar en un documento.
function shape(value, depth = 0) {
  if (depth > 4) return '…';
  if (Array.isArray(value)) return value.length === 0 ? '[]' : [`array(${value.length})`, shape(value[0], depth + 1)];
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) out[key] = shape(inner, depth + 1);
  return out;
}

const results = [];

async function probe(label, wsfunction, args = {}) {
  process.stdout.write(`· ${wsfunction} `);
  try {
    const data = await call(await tokenPromise, wsfunction, args);
    await fs.writeFile(path.join(OUT_DIR, `${wsfunction}${label ? `-${label}` : ''}.json`), JSON.stringify(data, null, 2));
    console.log('ok');
    results.push({ wsfunction, label, ok: true, shape: shape(data) });
    return data;
  } catch (err) {
    console.log(`ERROR ${err.errorcode ?? err.message}`);
    results.push({ wsfunction, label, ok: false, errorcode: err.errorcode ?? err.message });
    return null;
  }
}

let tokenPromise;

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true, mode: 0o700 });
  tokenPromise = getToken();
  await tokenPromise;

  console.log('\n── Identidad y catálogo de funciones ──');
  const site = await probe('', 'core_webservice_get_site_info');
  if (!site) throw new Error('Sin site info no hay recon');

  const available = new Set((site.functions ?? []).map((entry) => entry.name));
  console.log(`\nMoodle ${site.release ?? '?'} · ${available.size} funciones expuestas en moodle_mobile_app`);
  console.log('\n── Cobertura de lo que la integración necesita ──');
  for (const [area, functions] of Object.entries(NEEDED)) {
    const faltan = functions.filter((name) => !available.has(name));
    console.log(`${area.padEnd(12)} ${functions.length - faltan.length}/${functions.length}${faltan.length ? `  faltan: ${faltan.join(', ')}` : ''}`);
  }

  const userid = site.userid;
  console.log('\n── Superficie global ──');
  const courses = (await probe('', 'core_enrol_get_users_courses', { userid })) ?? [];
  await probe('', 'core_calendar_get_action_events_by_timesort', {
    timesortfrom: Math.floor(Date.now() / 1000) - 30 * 86400,
    limitnum: 50,
  });
  await probe('', 'gradereport_overview_get_course_grades', { userid });
  await probe('', 'message_popup_get_popup_notifications', { useridto: userid, limit: 20 });
  await probe('', 'core_message_get_conversations', { userid, limitnum: 10 });
  await probe('', 'core_user_get_private_files_info', { userid });
  await probe('', 'tool_mobile_get_config', {});

  const activos = courses.filter((course) => course.visible !== 0).slice(0, 3);
  console.log(`\n── Por curso (${activos.length} de ${courses.length} matriculados) ──`);
  const asignaciones = [];
  for (const course of activos) {
    const id = course.id;
    const contents = await probe(`c${id}`, 'core_course_get_contents', { courseid: id });
    if (contents) {
      const mods = contents.flatMap((section) => section.modules ?? []);
      const tipos = mods.reduce((acc, mod) => ({ ...acc, [mod.modname]: (acc[mod.modname] ?? 0) + 1 }), {});
      console.log(`  curso ${id}: ${contents.length} secciones, ${mods.length} módulos → ${JSON.stringify(tipos)}`);
    }
    const assigns = await probe(`c${id}`, 'mod_assign_get_assignments', { courseids: [id] });
    for (const assign of assigns?.courses?.[0]?.assignments ?? []) asignaciones.push(assign.id);
    await probe(`c${id}`, 'gradereport_user_get_grade_items', { courseid: id, userid });
    await probe(`c${id}`, 'mod_forum_get_forums_by_courses', { courseids: [id] });
    await probe(`c${id}`, 'mod_quiz_get_quizzes_by_courses', { courseids: [id] });
    await probe(`c${id}`, 'core_completion_get_activities_completion_status', { courseid: id, userid });
    await probe(`c${id}`, 'core_course_get_updates_since', { courseid: id, since: Math.floor(Date.now() / 1000) - 14 * 86400 });
  }

  console.log(`\n── Estado de entrega (${Math.min(asignaciones.length, 3)} tareas) ──`);
  for (const assignid of asignaciones.slice(0, 3)) {
    await probe(`a${assignid}`, 'mod_assign_get_submission_status', { assignid });
  }

  await fs.writeFile(path.join(OUT_DIR, '_formas.json'), JSON.stringify(results, null, 2));
  const fallidas = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - fallidas.length}/${results.length} llamadas ok. Volcados en ${OUT_DIR}`);
  if (fallidas.length) console.log(`Fallaron: ${fallidas.map((entry) => `${entry.wsfunction}(${entry.errorcode})`).join(', ')}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
