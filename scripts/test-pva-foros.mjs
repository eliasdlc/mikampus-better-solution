// Los mensajes de los foros de estudiantes, del sync a la herramienta del MCP.
//
// Lo que se prueba es lo que hace que un borrador de foro no repita a los
// compañeros ni conteste dos veces: que el sync guarde cada mensaje con su
// autor y marque lo propio, que una discusión quieta no cueste otra llamada,
// que un foro que falla no tumbe a los demás, y que la herramienta diga en
// `unknown` cuando un foro tiene discusiones pero ningún mensaje leído.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'mikampus-foros-'));
process.env.MIKAMPUS_DB = path.join(dir, 'test.db');
process.env.MIKAMPUS_DATA_DIR = dir;

const { db, logSync } = await import('../src/db.js');
const { saveIdentity } = await import('../src/moodle/identity.js');
const { saveCourses } = await import('../src/moodle/courses.js');
const { saveForums, syncForumPosts } = await import('../src/moodle/forums.js');

const fixture = async (name) => JSON.parse(await readFile(`fixtures/${name}`, 'utf8'));
const USER = 1;
const ME = 90001;
const NOW = new Date(1_771_900_000_000);

db.exec("INSERT OR IGNORE INTO users (id, portal_username) VALUES (1, 'elias.delacruz')");
saveIdentity(USER, await fixture('pva-site-info.json'));
saveCourses(USER, await fixture('pva-courses.json'), { now: NOW.getTime() });
const forums = await fixture('pva-forums.json');
const general = forums.find((f) => f.type !== 'news');
const quiet = { ...general, id: general.id + 1, cmid: general.cmid + 1, name: 'Foro que falla' };
saveForums(USER, [...forums, quiet], { now: NOW.getTime() });

const html = (text) => `<p>${text}</p>`;
const discussions = {
  [general.id]: { discussions: [{ id: 501, discussion: 70, timemodified: 1_771_000_100 }] },
};
const posts = {
  70: {
    posts: [
      { id: 801, discussionid: 70, hasparent: false, subject: 'Jailbreak en LLMs', message: html('Consigna del <b>profesor</b>'), author: { id: 7, fullname: 'Rafael Dorville' }, timecreated: 1_771_000_000 },
      { id: 802, discussionid: 70, hasparent: true, parentid: 801, subject: 'Re: Jailbreak', message: html('Un compañero habla de DAN'), author: { id: 11, fullname: 'Ana Pérez' }, timecreated: 1_771_000_050 },
      { id: 803, discussionid: 70, hasparent: true, parentid: 801, subject: 'Re: Jailbreak', message: html('Mi aporte'), author: { id: ME, fullname: 'Elias De La Cruz' }, timecreated: 1_771_000_100 },
    ],
  },
};
const calls = [];
const call = async (fn, args) => {
  calls.push(fn);
  if (fn === 'mod_forum_get_forum_discussions') {
    if (args.forumid === quiet.id) throw new Error('fixture: forum unavailable');
    return discussions[args.forumid] ?? { discussions: [] };
  }
  if (fn === 'mod_forum_get_discussion_posts') return posts[args.discussionid];
  throw new Error(`unexpected ${fn}`);
};

// ── El sync guarda los mensajes y marca lo propio ──────────────────────────
const first = await syncForumPosts(USER, { call, now: NOW.getTime() });
assert.equal(first.saved, 3, 'los tres mensajes de la discusión');
assert.deepEqual(first.failed.map((f) => f.forumId), [quiet.id], 'el foro que falla queda nombrado');
const rows = db.prepare('SELECT post_id, parent_id, author, is_mine, message_text FROM pva_forum_post ORDER BY post_id').all();
assert.equal(rows[0].parent_id, null, 'el que abre la discusión no tiene padre');
assert.equal(rows[0].message_text, 'Consigna del profesor', 'sin HTML');
assert.deepEqual(rows.map((r) => r.is_mine), [0, 0, 1], 'solo el de la persona es suyo');

// ── Una discusión que no cambió no cuesta otra llamada ─────────────────────
calls.length = 0;
const second = await syncForumPosts(USER, { call, now: NOW.getTime() });
assert.equal(second.saved, 0);
assert.ok(!calls.includes('mod_forum_get_discussion_posts'), 'una discusión quieta no se vuelve a leer');

// ── La herramienta del MCP ─────────────────────────────────────────────────
logSync({ userId: USER, kind: 'pvaForums', status: 'ok' });
const { READ_TOOLS } = await import('../src/mcp/tools.js');
const { pvaForumEnvelopeSchema } = await import('../src/shared/mcp.ts');
const tool = READ_TOOLS.find((t) => t.name === 'get_pva_forum');
assert.ok(tool, 'la herramienta existe en el carril de lectura');

const answer = tool.run({ forumId: general.id, now: NOW });
pvaForumEnvelopeSchema.parse(answer.payload);
const data = answer.payload.data;
assert.equal(data.forum.answeredByMe, true);
assert.equal(data.discussions.length, 1);
assert.deepEqual(data.discussions[0].posts.map((p) => p.author), ['Rafael Dorville', 'Ana Pérez', 'Elias De La Cruz']);
assert.equal(answer.payload.unknown.length, 0);

// Un foro con discusiones pero sin mensajes leídos lo dice en vez de parecer vacío.
db.prepare('UPDATE pva_forum SET num_discussions = 4 WHERE forum_id = ?').run(quiet.id);
const unread = tool.run({ forumId: quiet.id, now: NOW });
pvaForumEnvelopeSchema.parse(unread.payload);
assert.equal(unread.payload.unknown[0]?.kind, 'pva_mensajes_de_foro');

// Por nombre: una sola coincidencia se resuelve sola.
const byName = tool.run({ query: 'falla', now: NOW });
assert.equal(byName.payload.data.forum?.forumId, quiet.id);

console.log('foros: ok');
