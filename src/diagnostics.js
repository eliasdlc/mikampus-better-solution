import fs from 'node:fs';
import path from 'node:path';
import { dataPaths } from './paths.js';

// Diagnósticos (Fase 4 §10). Un scraper que falla necesita evidencia, y la
// evidencia de PeopleSoft es PII por definición: una captura del portal muestra
// matrícula, nombre y notas. Las reglas son tres:
//
//   1. Todo diagnóstico vive bajo app-data/diagnostics, con permisos 0700.
//      Nunca junto al ejecutable, nunca en el CWD (antes las capturas de login
//      caían en ./screenshots del directorio desde donde arrancara el proceso).
//   2. El texto se redacta antes de escribirse. Las capturas no se pueden
//      redactar, así que su contención es la carpeta: no se exportan solas.
//   3. Salen de ahí únicamente con `exportDiagnostics`, que es una acción
//      explícita del usuario.

export const diagnosticsDir = path.join(dataPaths().dataDir, 'diagnostics');

const KEEP = Math.max(1, Number(process.env.MIKAMPUS_DIAGNOSTICS_KEEP || 20));

// Lo que jamás debe quedar escrito en un archivo que el usuario podría adjuntar
// a un issue. Cubre lo mismo que la política de fixtures: tokens de estado de
// PeopleSoft, identificadores de estudiante y cualquier credencial en tránsito.
const REDACTIONS = [
  [/(ICSID|ICStateNum|ICNAVTYPEDROPDOWN)=[^&\s"'<>]+/gi, '$1=[redactado]'],
  [/(EMPLID|ENRL_REQUEST_ID|STUDENT_ID)["'\s:=]+([A-Za-z0-9-]+)/gi, '$1=[redactado]'],
  [/(password|passwd|pwd|contraseña)["'\s:=]+\S+/gi, '$1=[redactado]'],
  [/(Cookie|Set-Cookie|Authorization)\s*:\s*[^\n]+/gi, '$1: [redactado]'],
  [/\b\d{4}-\d{4}\b/g, '[matrícula-redactada]'],
];

export function redact(text) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

function ensureDir() {
  fs.mkdirSync(diagnosticsDir, { recursive: true, mode: 0o700 });
  return diagnosticsDir;
}

function stamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

// Retención chica y automática: un diagnóstico viejo no ayuda a depurar nada y
// sí alarga la vida de una captura con PII adentro.
export function pruneDiagnostics(keep = KEEP) {
  if (!fs.existsSync(diagnosticsDir)) return [];
  const files = fs
    .readdirSync(diagnosticsDir)
    .map((name) => ({ name, at: fs.statSync(path.join(diagnosticsDir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  const removed = [];
  for (const file of files.slice(keep)) {
    fs.rmSync(path.join(diagnosticsDir, file.name), { force: true });
    removed.push(file.name);
  }
  return removed;
}

export function writeDiagnostic(name, text, { now = new Date() } = {}) {
  ensureDir();
  const target = path.join(diagnosticsDir, `${stamp(now)}-${name}.txt`);
  fs.writeFileSync(target, redact(text), { mode: 0o600 });
  pruneDiagnostics();
  return target;
}

// Una captura solo se toma si el usuario dejó los diagnósticos encendidos.
// Apagados por defecto sería inservible para depurar; encendidos y fuera de
// app-data sería una filtración. El punto medio: se toman siempre, pero solo
// acá adentro, y `MIKAMPUS_DIAGNOSTICS=off` las desactiva del todo.
export function diagnosticsEnabled(env = process.env) {
  return String(env.MIKAMPUS_DIAGNOSTICS ?? '').toLowerCase() !== 'off';
}

export async function captureFailure(page, name, { now = new Date() } = {}) {
  if (!diagnosticsEnabled() || !page) return null;
  ensureDir();
  const target = path.join(diagnosticsDir, `${stamp(now)}-${name}.png`);
  try {
    await page.screenshot({ path: target, timeout: 5000 });
  } catch {
    return null;
  }
  fs.chmodSync(target, 0o600);
  pruneDiagnostics();
  return target;
}

export function listDiagnostics() {
  if (!fs.existsSync(diagnosticsDir)) return [];
  return fs
    .readdirSync(diagnosticsDir)
    .map((name) => {
      const stats = fs.statSync(path.join(diagnosticsDir, name));
      return { name, bytes: stats.size, at: new Date(stats.mtimeMs).toISOString(), pii: name.endsWith('.png') };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

// La única salida. Copia (no mueve) a una carpeta que el usuario eligió, y
// devuelve exactamente qué se copió para que pueda revisarlo antes de adjuntar
// nada: una captura del portal sigue siendo PII fuera de app-data.
export function exportDiagnostics(targetDir) {
  if (!targetDir) throw new Error('Indicá a qué carpeta exportar los diagnósticos');
  const resolved = path.resolve(targetDir);
  fs.mkdirSync(resolved, { recursive: true });
  const exported = [];
  for (const entry of listDiagnostics()) {
    const to = path.join(resolved, entry.name);
    fs.copyFileSync(path.join(diagnosticsDir, entry.name), to);
    exported.push({ ...entry, path: to });
  }
  return { directory: resolved, files: exported };
}

export function clearDiagnostics() {
  fs.rmSync(diagnosticsDir, { recursive: true, force: true });
}
