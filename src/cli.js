#!/usr/bin/env node
import { CLI_COMMANDS } from './cliCommands.js';
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
import { resourceRoot } from './paths.js';
import { checkForUpdate, currentVersion, setUpdatePolicy, updatePolicy } from './updates.js';
import { LOCAL_USER_ID } from './users.js';

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
    ['browser compatible', browser.installed ? (browser.source === 'system' ? 'Chrome/Chromium del sistema' : 'administrado por mikampus') : false],
    ['hay al menos una copia verificable', backup.copies.length > 0],
  ];
  for (const [name, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!browser.installed) console.log('  → instalá Chrome/Chromium o corré `mikampus install-browser` (también desde el onboarding)');
  if (backup.copies.length === 0) console.log('  → corré `mikampus backup` para crear la primera copia');
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}
function serviceDefinition() {
  const node = process.execPath; const entry = path.join(here, 'launcher.js');
  // WorkingDirectory no es cosmético: `dotenv` resuelve `.env` contra el cwd, y
  // un servicio de systemd arranca en el home del usuario. Sin esto el agente
  // durable pierde silenciosamente lo que el arranque manual sí lee (llaves
  // VAPID, topic de ntfy) y la diferencia solo se nota cuando algo no avisa.
  if (process.platform === 'linux') return { file: path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, '.config'), 'systemd/user/mikampus.service'), content: `[Unit]\nDescription=mikampus local agent\n[Service]\nWorkingDirectory=${resourceRoot}\nExecStart=${node} ${entry}\nRestart=on-failure\nRestartSec=3\nEnvironment=MIKAMPUS_AGENT_TOKEN=${agentToken()}\n[Install]\nWantedBy=default.target\n` };
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
/**
 * Sincroniza el aula y sube a Kino lo que publicó.
 *
 * Es lo que invoca el timer de systemd cada seis horas, en el laptop y en
 * agentbox. Corre entero sin nadie delante, así que imprime el resumen y sale
 * con 0 salvo que la subida fallara: un timer que siempre sale bien es un timer
 * que no dice nada cuando deja de funcionar.
 *
 * `--dry-run` enseña exactamente lo que subiría sin tocar Kino ni marcar nada.
 */
async function aulaAKino() {
  const dryRun = process.argv.includes('--dry-run');
  const { runSync } = await import('./syncOrchestrator.js');
  const { previewBatch, pushToKino, kinoConfig, pendingCount } = await import('./moodle/kinoSync.js');

  if (!kinoConfig() && !dryRun) {
    console.log('aula-a-kino: apagado. Faltan KINO_ACADEMICO_URL y KINO_ACADEMICO_TOKEN.');
    return;
  }

  // Solo las fuentes del aula: el portal de MiCampus no tiene nada que ver acá
  // y su sesión de Playwright es la que no se puede ocupar por gusto.
  const keys = ['pvaIdentity', 'pvaConfig', 'pvaCourses', 'pvaAssignments', 'pvaContents', 'pvaNotifications', 'pvaAlerts'];
  const results = await runSync(LOCAL_USER_ID, { keys, emit: () => {} });
  const fallidas = (results ?? []).filter((r) => r?.ok === false).map((r) => r.key);
  console.log(`aula-a-kino: ${keys.length - fallidas.length}/${keys.length} fuentes al día${fallidas.length ? ` · fallaron: ${fallidas.join(', ')}` : ''}`);

  if (dryRun) {
    const { items } = previewBatch(LOCAL_USER_ID);
    console.log(`aula-a-kino: ${pendingCount(LOCAL_USER_ID)} pendiente(s), ${items.length} en el próximo envío`);
    console.log(JSON.stringify(items, null, 2));
    return;
  }

  const res = await pushToKino(LOCAL_USER_ID);
  if (res.error) {
    console.error(`aula-a-kino: la subida falló${res.status ? ` (${res.status})` : ''} — ${res.error}`);
    process.exitCode = 1;
    return;
  }
  if (res.skipped) {
    console.log(`aula-a-kino: ${res.skipped}`);
    return;
  }
  console.log(`aula-a-kino: ${res.sent} subido(s), ${res.marked ?? 0} asentado(s)${res.kino ? ` · Kino: ${res.kino.creadas ?? 0} nueva(s), ${res.kino.actualizadas ?? 0} actualizada(s)` : ''}`);
  for (const materia of res.kino?.sinCarpeta ?? []) console.log(`aula-a-kino: sin carpeta en Kino para "${materia}"`);
}

/**
 * El login de Teams, que es el unico momento en que este proyecto abre una
 * ventana. Una pantalla de MFA institucional no se resuelve headless, y un
 * segundo factor no se guarda en un fichero: lo que se guarda es el resultado.
 */
async function teamsLogin() {
  const { teamsLogin: login, teamsStatePath } = await import('./teams/session.js');
  console.log('Se va a abrir una ventana de Chromium en Teams. Entrá con tu cuenta de PUCMM.');
  console.log('Cuando la aplicacion cargue, la sesion se guarda sola y la ventana se cierra.\n');
  try {
    await login();
    console.log(`Sesion guardada en ${teamsStatePath()} (modo 600).`);
    console.log('Dura lo que duren las cookies de Microsoft; cuando caduque hay que repetirlo.');
  } catch (err) {
    console.error(`El login no termino: ${err.message}`);
    process.exitCode = 1;
  }
}

/**
 * Sin flags dice si hay fichero de sesión. Con `--check` la usa: sale 0 si
 * SharePoint la acepta y 2 si falta o caducó, para que un timer pueda avisar.
 */
async function teamsStatus() {
  if (process.argv.includes('--check')) {
    const { teamsSessionState } = await import('./teams/session.js');
    const state = await teamsSessionState();
    const messages = {
      alive: 'Teams: sesion viva.',
      expired: 'Teams: sesion caducada. Corré `mikampus teams-login` en una maquina con pantalla.',
      missing: 'Teams: sin sesion. Corré `mikampus teams-login` en una maquina con pantalla.',
    };
    console.log(messages[state]);
    if (state !== 'alive') process.exitCode = 2;
    return;
  }
  return import('./teams/session.js').then(({ hasTeamsSession, teamsStatePath }) => {
    if (!hasTeamsSession()) {
      console.log('Teams: sin sesion. Corré `mikampus teams-login`.');
      return;
    }
    const stat = fs.statSync(teamsStatePath());
    const dias = Math.floor((Date.now() - stat.mtimeMs) / 86_400_000);
    console.log(`Teams: sesion guardada hace ${dias} dia(s) en ${teamsStatePath()}.`);
    console.log('Que exista no prueba que siga viva: eso solo lo dice usarla.');
  });
}

/**
 * Busca en OneDrive lo que Teams subio al terminar una clase y lo deja donde el
 * vigilante lo recoge. Es lo que invoca el timer, y no abre ninguna ventana.
 */
async function teamsSync() {
  const dryRun = process.argv.includes('--dry-run');
  const { sync, transcriptsDir, RECENT_HOURS } = await import('./teams/transcripts.js');
  // `--hours N` mira mas atras que el barrido normal, para recuperar clases
  // que se publicaron cuando nada estaba mirando.
  const at = process.argv.indexOf('--hours');
  const hours = at === -1 ? RECENT_HOURS : Number(process.argv[at + 1]);
  if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 180) {
    console.error('teams-sync: --hours espera un entero entre 1 y 4320');
    process.exitCode = 1;
    return;
  }
  const res = await sync({ dryRun, hours });

  if (res.needsLogin) {
    console.error('teams-sync: no hay sesion de Teams. Corré `mikampus teams-login` una vez.');
    process.exitCode = 1;
    return;
  }
  console.log(`teams-sync: ${res.recordings.length} grabacion(es) reciente(s)`);
  for (const bajada of res.bajadas) {
    if (bajada.dryRun) console.log(`teams-sync: bajaria ${bajada.name}`);
    else console.log(`teams-sync: ${bajada.skipped ? 'ya estaba' : 'bajada'} ${bajada.path}${bajada.bytes ? ` (${bajada.bytes} bytes)` : ''}`);
  }
  // Lo normal en los minutos siguientes a colgar: el video ya subio y la
  // transcripcion se esta generando. Se dice, porque el silencio aqui parece un
  // fallo y no lo es.
  for (const nombre of res.sinTranscripcion) console.log(`teams-sync: sin transcripcion todavia: ${nombre}`);
  if (!res.bajadas.length && !res.sinTranscripcion.length && !dryRun) console.log(`teams-sync: nada nuevo en ${transcriptsDir()}`);
  for (const fallo of res.fallos) console.error(`teams-sync: ${fallo}`);
  if (res.fallos.length && !res.bajadas.length) process.exitCode = 1;
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
  if (command === 'version') return console.log(currentVersion());
  if (command === 'start') return start(); if (command === 'stop') return stop(); if (command === 'status') return status(); if (command === 'open') return open(); if (command === 'doctor') return doctor(); if (command === 'install-browser') return installBrowser();
  if (command === 'install-service') return installService(false); if (command === 'uninstall-service') return installService(true);
  if (command === 'backup') return backup(); if (command === 'restore') return restore(process.argv[3]);
  if (command === 'erase-data') return eraseData(); if (command === 'uninstall') return uninstall();
  if (command === 'diagnostics') return diagnostics(); if (command === 'update') return update();
  if (command === 'aula-a-kino') return aulaAKino();
  if (command === 'teams-login') return teamsLogin(); if (command === 'teams-status') return teamsStatus();
  if (command === 'teams-sync') return teamsSync();
  // La lista de CLI_COMMANDS y este dispatch tienen que decir lo mismo: si se
  // agrega un comando arriba y no a la lista, el launcher lo manda al server.
  throw new Error(`Comando desconocido: ${command}. Comandos: ${CLI_COMMANDS.join(', ')}`);
}
main().catch((error) => { console.error(`mikampus: ${error.message}`); process.exitCode = 1; });
