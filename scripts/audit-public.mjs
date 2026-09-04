// Gate para lo que puede publicarse. Deliberadamente nunca imprime el valor
// coincidente: un scanner no debe convertir un secreto en salida de CI.
import { execFileSync } from 'node:child_process';

const mode = process.argv.includes('--history') ? 'history' : 'head';
const ignored = new Set(['package-lock.json']);
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/,
  /AKIA[0-9A-Z]{16}/
];
const environmentSecret = /^(?:PUCMM_(?:USERNAME|PASSWORD)|MIKAMPUS_PORTAL_PASSWORD|LITESTREAM_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY))[ \t]*=[ \t]*(?!$|#|<)\S+/m;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function textAt(revision, file) {
  try {
    return git(['show', `${revision}:${file}`]);
  } catch {
    return null;
  }
}

function filesAt(revision) {
  if (revision === 'HEAD') return git(['ls-files', '-z']).split('\0').filter(Boolean);
  return git(['ls-tree', '-r', '--name-only', revision]).split('\n').filter(Boolean);
}

function changedFilesAt(revision) {
  return git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', revision]).split('\n').filter(Boolean);
}

function fixtureFindings(text) {
  const findings = [];
  for (const tag of text.match(/<input\b[^>]*>/gi) ?? []) {
    const name = /\b(?:id|name)\s*=\s*(["'])(ICSID|ICStateNum)\1/i.exec(tag)?.[2];
    if (!name) continue;
    const value = /\bvalue\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2];
    if (value !== 'SCRUBBED_FOR_FIXTURE') findings.push(`${name} no está sanitizado`);
  }
  for (const field of ['EMPLID', 'ENRL_REQUEST_ID']) {
    const values = [...text.matchAll(new RegExp(`${field}(?:=|:\\")([0-9]{6,})`, 'g'))].map((match) => match[1]);
    if (values.some((value) => !/^0+$/.test(value))) findings.push(`${field} contiene un identificador no sintético`);
  }
  const names = [...text.matchAll(/id=["']DERIVED_SSTSNAV_PERSON_NAME["'][^>]*>(?:<[^>]+>)*([^<]+)/gi)].map((match) => match[1].trim());
  if (names.some((name) => name && !/^(?:ESTUDIANTE|DE|LA|PRUEBA|&nbsp;|\s)+$/.test(name))) {
    findings.push('nombre de estudiante no está sanitizado');
  }
  return findings;
}

function auditRevision(revision, files = filesAt(revision)) {
  const findings = [];
  for (const file of files) {
    if (ignored.has(file)) continue;
    const text = textAt(revision, file);
    if (text == null || text.includes('\0')) continue;
    if (secretPatterns.some((pattern) => pattern.test(text)) || (file.startsWith('.env') && environmentSecret.test(text))) {
      findings.push(`${revision}:${file}: posible secreto`);
    }
    if (file.startsWith('fixtures/') && file.endsWith('.html')) {
      for (const detail of fixtureFindings(text)) findings.push(`${revision}:${file}: ${detail}`);
    }
  }
  return findings;
}

const revisions = mode === 'history'
  ? git(['rev-list', '--branches', '--remotes']).split('\n').filter(Boolean)
  : ['HEAD'];
// Para historia solo se leen los archivos añadidos o modificados por cada
// commit. Así se cubre el instante en que un valor entró al historial sin
// volver a leer el árbol entero por cada revisión.
const findings = mode === 'history'
  ? revisions.flatMap((revision) => auditRevision(revision, changedFilesAt(revision)))
  : revisions.flatMap((revision) => auditRevision(revision));

if (findings.length) {
  console.error(`Auditoría ${mode}: ${findings.length} hallazgo(s), sin exponer valores:`);
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`✓ Auditoría ${mode}: ${revisions.length} revisión(es) sin secretos o PII conocida`);
