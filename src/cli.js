#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { backupState, createBackup, exportBackup, verifyBackup } from './backups.js';
import { db, DB_PATH, schemaState } from './db.js';
import { agentToken, lockPath, processIsAlive, readAgentLock, runtimeDir } from './runtime.js';
import { browserStatus, installBrowser } from './browser.js';
import { erasePreview, eraseLocalArtifacts } from './erase.js';
import { exportDiagnostics, listDiagnostics } from './diagnostics.js';
import { SCHEMA_VERSION } from './migrations.js';
import { checkForUpdate, currentVersion, setUpdatePolicy, updatePolicy } from './updates.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const command = process.argv[2] || 'status';
const port = Number(process.env.PORT || 4173);
const baseUrl = `http://127.0.0.1:${port}`;

async function health() {
  try {
    const response = await fetch(`${baseUrl}/api/health`, { headers: { 'x-mikampus-agent-token': agentToken() }, signal: AbortSignal.timeout(800) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}
async function waitForHealth(ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const result = await health();
    if (result?.ok) return result;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('El agente no respondió al healthcheck autenticado');
}
async function start() {
  const existing = await health();
  if (existing?.ok) return console.log(`mikampus ya está activo en ${existing.url}`);
  const lock = readAgentLock();
  if (lock && processIsAlive(lock.pid)) throw new Error(`Hay un proceso vivo (PID ${lock.pid}) pero su healthcheck falló; no se iniciará otro agente.`);
  const child = spawn(process.execPath, [path.join(here, 'launcher.js')], {
    detached: true, stdio: 'ignore', env: { ...process.env, MIKAMPUS_AGENT_TOKEN: agentToken() },
  });
  child.unref();
  const ready = await waitForHealth();
  console.log(`mikampus iniciado en ${ready.url} (PID ${ready.pid})`);
}
async function stop() {
  const lock = readAgentLock();
  if (!lock || !processIsAlive(lock.pid)) return console.log('mikampus ya está detenido');
  process.kill(lock.pid, 'SIGTERM');
  const until = Date.now() + 8000;
  while (Date.now() < until && processIsAlive(lock.pid)) await new Promise((resolve) => setTimeout(resolve, 100));
  if (processIsAlive(lock.pid)) throw new Error(`El agente ${lock.pid} no se detuvo; no se fuerza su terminación.`);
  console.log('mikampus detenido');
}
async function status() {
  const lock = readAgentLock(); const live = await health();
  const watcher = db.prepare('SELECT status, last_check_at AS lastCheckAt, next_check_at AS nextCheckAt, pause_reason AS pauseReason, consecutive_failures AS consecutiveFailures FROM watchers WHERE user_id = 1').get() ?? null;
  const backup = backupState();
  console.log(JSON.stringify({
    version: currentVersion(),
    running: Boolean(live?.ok), pid: lock?.pid ?? null, port, runtimeDir, lock: lockPath, watcher,
    schema: { version: SCHEMA_VERSION, applied: schemaState.applied },
    backup: { lastSuccessfulAt: backup.lastSuccessfulAt, nextRunAt: backup.nextRunAt, keep: backup.keep, copies: backup.copies.length },
    updates: updatePolicy(),
  }, null, 2));
  if (!live?.ok) process.exitCode = 1;
}
async function open() {
  if (!(await health())?.ok) await start();
  const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', baseUrl]] : process.platform === 'darwin' ? ['open', [baseUrl]] : ['xdg-open', [baseUrl]];
  const result = spawnSync(opener[0], opener[1], { stdio: 'ignore' });
  if (result.error) console.log(`Abrí ${baseUrl} en tu navegador.`);
}
async function doctor() {
  const browser = await browserStatus();
  const backup = backupState();
  const checks = [
    ['Node >= 24', Number(process.versions.node.split('.')[0]) >= 24],
    ['runtime privado', (() => { try { fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 }); return true; } catch { return false; } })()],
    ['base de datos configurable', Boolean(DB_PATH)],
    [`esquema ${SCHEMA_VERSION} aplicado`, true],
    ['browser administrado instalado', browser.installed],
    ['hay al menos una copia verificable', backup.copies.length > 0],
  ];
  for (const [name, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!browser.installed) console.log('  → corré `mikampus install-browser` (o completá el onboarding en la UI)');
  if (backup.copies.length === 0) console.log('  → corré `mikampus backup` para crear la primera copia');
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}
function serviceDefinition() {
  const node = process.execPath; const entry = path.join(here, 'launcher.js');
  if (process.platform === 'linux') return { file: path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, '.config'), 'systemd/user/mikampus.service'), content: `[Unit]\nDescription=mikampus local agent\n[Service]\nExecStart=${node} ${entry}\nRestart=on-failure\nRestartSec=3\nEnvironment=MIKAMPUS_AGENT_TOKEN=${agentToken()}\n[Install]\nWantedBy=default.target\n` };
  if (process.platform === 'darwin') return { file: path.join(process.env.HOME, 'Library/LaunchAgents/dev.mikampus.agent.plist'), content: `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>dev.mikampus.agent</string><key>ProgramArguments</key><array><string>${node}</string><string>${entry}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>\n` };
  return { file: path.join(runtimeDir, 'mikampus-task.cmd'), content: `@echo off\r\n"${node}" "${entry}"\r\n` };
}
function installService(remove = false) {
  const def = serviceDefinition();
  if (remove) { try { fs.unlinkSync(def.file); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  else { fs.mkdirSync(path.dirname(def.file), { recursive: true }); fs.writeFileSync(def.file, def.content, { mode: 0o600 }); }
  if (process.platform === 'linux') spawnSync('systemctl', ['--user', 'daemon-reload']);
  if (process.platform === 'linux') spawnSync('systemctl', ['--user', remove ? 'disable' : 'enable', '--now', 'mikampus.service']);
  if (process.platform === 'darwin') spawnSync('launchctl', [remove ? 'bootout' : 'bootstrap', `gui/${process.getuid()}`, def.file]);
  if (process.platform === 'win32') spawnSync('schtasks', remove ? ['/Delete', '/TN', 'mikampus', '/F'] : ['/Create', '/TN', 'mikampus', '/SC', 'ONLOGON', '/TR', def.file, '/F']);
  console.log(`${remove ? 'Servicio retirado' : 'Servicio instalado'}: ${def.file}`);
}
function restore(file) {
  if (!file || !fs.existsSync(file)) throw new Error('Indicá un backup SQLite existente para restore');
  const lock = readAgentLock();
  if (lock && processIsAlive(lock.pid)) throw new Error('Detené el agente antes de restaurar para evitar corrupción');
  // La misma verificación que se hace al crear la copia: integridad, esquema
  // legible por esta versión y contenido real. Restaurar sin verificar es cómo
  // se descubre a destiempo que el respaldo estaba vacío.
  const verified = verifyBackup(file);
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.copyFileSync(file, DB_PATH);
  // El WAL viejo pertenece a la base anterior: dejarlo puede reintroducir
  // escrituras que la copia no tenía.
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${DB_PATH}${suffix}`, { force: true });
  console.log(`Backup restaurado en ${DB_PATH} (esquema ${verified.schema}, ${verified.tables} tablas)`);
}
function backup() {
  const index = process.argv.indexOf('--to');
  if (index === -1) return console.log(createBackup());
  const result = exportBackup(process.argv[index + 1]);
  console.log(`Copia exportada a ${result.file} (${result.bytes} bytes, esquema ${result.schema})`);
  if (result.sameDisk) console.log('Aviso: el destino está en el mismo disco que tus datos; no cubre robo ni daño físico.');
}
function printErasePreview(preview) {
  console.log('Se va a borrar:');
  for (const target of preview.targets) {
    console.log(`  ${target.exists ? '•' : '·'} ${target.label}: ${target.path}${target.exists ? ` (${target.bytes} bytes)` : ' (no existe)'}`);
  }
  for (const item of preview.external) console.log(`  • ${item.label} — ${item.purpose}`);
  console.log(preview.note);
  console.log('Queda fuera del alcance de mikampus:');
  for (const item of preview.outsideReach) console.log(`  · ${item.label} — ${item.purpose}`);
}
async function eraseData() {
  const preview = erasePreview();
  printErasePreview(preview);
  if (!process.argv.includes('--yes')) {
    console.log('\nNada se borró todavía. Repetí con --yes para confirmar (agregá --keep-backups para conservar las copias).');
    return;
  }
  await stop();
  const keep = process.argv.includes('--keep-backups') ? ['backups'] : [];
  const removed = eraseLocalArtifacts({ keep });
  for (const target of removed) console.log(`borrado: ${target}`);
  console.log(keep.length ? 'Datos y secretos eliminados; las copias quedaron donde estaban.' : 'Datos locales, secretos, copias, diagnósticos y runtime eliminados.');
}
async function uninstall() {
  // Desinstalar es dos cosas distintas: sacar el servicio del OS y decidir qué
  // pasa con los datos. Se hacen en ese orden y la segunda siempre pregunta.
  installService(true);
  await eraseData();
}
function diagnostics() {
  const index = process.argv.indexOf('--export');
  if (index === -1) {
    const files = listDiagnostics();
    if (files.length === 0) return console.log('No hay diagnósticos guardados.');
    for (const file of files) console.log(`${file.at}  ${file.name}  ${file.bytes} bytes${file.pii ? '  (captura: puede mostrar datos del portal)' : ''}`);
    return;
  }
  const result = exportDiagnostics(process.argv[index + 1]);
  console.log(`${result.files.length} archivo(s) exportado(s) a ${result.directory}. Revisalos antes de compartirlos.`);
}
async function update() {
  const index = process.argv.indexOf('--policy');
  if (index !== -1) return console.log(`Política de updates: ${setUpdatePolicy(process.argv[index + 1])}`);
  const result = await checkForUpdate();
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'update-available') {
    console.log('\nLa descarga se verifica por SHA-256 antes de instalarse; el instalador por plataforma llega con la fase de distribución.');
  }
}
async function main() {
  if (command === 'start') return start(); if (command === 'stop') return stop(); if (command === 'status') return status(); if (command === 'open') return open(); if (command === 'doctor') return doctor(); if (command === 'install-browser') return installBrowser();
  if (command === 'install-service') return installService(false); if (command === 'uninstall-service') return installService(true);
  if (command === 'backup') return backup(); if (command === 'restore') return restore(process.argv[3]);
  if (command === 'erase-data') return eraseData(); if (command === 'uninstall') return uninstall();
  if (command === 'diagnostics') return diagnostics(); if (command === 'update') return update();
  throw new Error(`Comando desconocido: ${command}`);
}
main().catch((error) => { console.error(`mikampus: ${error.message}`); process.exitCode = 1; });
