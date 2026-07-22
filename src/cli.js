#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createBackup } from './backups.js';
import { db, DB_PATH } from './db.js';
import { agentToken, lockPath, processIsAlive, readAgentLock, runtimeDir } from './runtime.js';
import { dataPaths } from './paths.js';
import { installBrowser } from './browser.js';

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
  console.log(JSON.stringify({ running: Boolean(live?.ok), pid: lock?.pid ?? null, port, runtimeDir, lock: lockPath, watcher }, null, 2));
  if (!live?.ok) process.exitCode = 1;
}
async function open() {
  if (!(await health())?.ok) await start();
  const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', baseUrl]] : process.platform === 'darwin' ? ['open', [baseUrl]] : ['xdg-open', [baseUrl]];
  const result = spawnSync(opener[0], opener[1], { stdio: 'ignore' });
  if (result.error) console.log(`Abrí ${baseUrl} en tu navegador.`);
}
function doctor() {
  const checks = [
    ['Node >= 24', Number(process.versions.node.split('.')[0]) >= 24],
    ['runtime privado', (() => { try { fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 }); return true; } catch { return false; } })()],
    ['base de datos configurable', Boolean(DB_PATH)],
  ];
  for (const [name, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${name}`);
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
  const probe = new DatabaseSync(file, { readOnly: true });
  try {
    const result = probe.prepare('PRAGMA integrity_check').get();
    if (result.integrity_check !== 'ok') throw new Error(`El backup no pasó integrity_check: ${result.integrity_check}`);
  } finally { probe.close(); }
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.copyFileSync(file, DB_PATH); console.log(`Backup restaurado en ${DB_PATH}`);
}
async function eraseData() {
  if (!process.argv.includes('--yes')) throw new Error('erase-data requiere --yes: borra credenciales, SQLite, backups y runtime local.');
  await stop();
  const { credentials: credentialDb, backups: backupDir } = dataPaths();
  const targets = [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, credentialDb, `${credentialDb}-wal`, `${credentialDb}-shm`, backupDir, runtimeDir];
  for (const target of targets) fs.rmSync(target, { recursive: true, force: true, maxRetries: 1 });
  console.log('Datos locales, secretos, backups y runtime eliminados.');
}
async function main() {
  if (command === 'start') return start(); if (command === 'stop') return stop(); if (command === 'status') return status(); if (command === 'open') return open(); if (command === 'doctor') return doctor(); if (command === 'install-browser') return installBrowser();
  if (command === 'install-service') return installService(false); if (command === 'uninstall-service') return installService(true);
  if (command === 'backup') return console.log(createBackup()); if (command === 'restore') return restore(process.argv[3]);
  if (command === 'erase-data') return eraseData();
  throw new Error(`Comando desconocido: ${command}`);
}
main().catch((error) => { console.error(`mikampus: ${error.message}`); process.exitCode = 1; });
