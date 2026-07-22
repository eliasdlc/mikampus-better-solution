import fs from 'node:fs';
import { readMeta, writeMeta } from './appMeta.js';
import { browserStatus, installBrowser } from './browser.js';
import { dataPaths } from './paths.js';
import { db } from './db.js';
import { LOCAL_USER_ID } from './users.js';

// Primer uso sin terminal (Fase 4 §1 y §2). El orden importa y no es
// cosmético: elegir modo → verificar prerequisitos → instalar el browser →
// recién entonces pedir la credencial. Pedir la contraseña antes de tener
// Chromium significa recibirla, fallar al verificarla y tener que decidir qué
// hacer con ella mientras se descargan 160 MiB. Así nunca la pedimos sin poder
// usarla de inmediato.

export const MODES = {
  desktop: {
    id: 'desktop',
    label: 'Local Desktop',
    summary: 'Corre en esta computadora y vigila solo mientras esté encendida, despierta y con internet.',
    guarantees: [
      'Notificaciones nativas del sistema, aunque cierres la pestaña.',
      'La credencial persistida vive en el almacén seguro del sistema operativo.',
      'Dormir, hibernar o apagar pausa todo: al volver se registra el intervalo no vigilado.',
    ],
  },
  'home-server': {
    id: 'home-server',
    label: 'Home Server',
    summary: 'Corre en un equipo tuyo siempre encendido (Raspberry Pi, NAS, mini-PC).',
    guarantees: [
      'Vigila 24/7 solo si ese equipo, su red y su corriente también lo son.',
      'La UI se sirve en loopback: se accede por túnel SSH, nunca exponiéndola a Internet.',
      'Sin escritorio no hay notificación nativa: el feed local es la base y cualquier adaptador externo es opt-in.',
    ],
  },
};

const MODE_KEY = 'runtime.mode';
const COMPLETED_KEY = 'onboarding.completedAt';

export function runtimeMode() {
  // Un despliegue de Home Server declara su modo por entorno; el Desktop lo
  // elige la persona en el onboarding.
  const fromEnv = process.env.MIKAMPUS_RUNTIME_MODE;
  if (fromEnv && MODES[fromEnv]) return fromEnv;
  const stored = readMeta(MODE_KEY);
  return stored && MODES[stored] ? stored : null;
}

export function chooseMode(mode) {
  if (!MODES[mode]) throw new Error(`Modo desconocido: ${mode}`);
  writeMeta(MODE_KEY, mode);
  return MODES[mode];
}

function writable(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.accessSync(directory, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Prerequisitos verificables sin tocar el portal ni pedir una contraseña.
export function prerequisites() {
  const paths = dataPaths();
  const major = Number(process.versions.node.split('.')[0]);
  return [
    {
      id: 'node',
      label: `Node ${process.versions.node}`,
      ok: major >= 24,
      detail: major >= 24 ? 'cumple el mínimo (24)' : 'mikampus necesita Node 24 o superior',
    },
    {
      id: 'data-dir',
      label: 'Carpeta de datos',
      ok: writable(paths.dataDir),
      detail: paths.dataDir,
    },
    {
      id: 'backups',
      label: 'Carpeta de copias',
      ok: writable(paths.backups),
      detail: paths.backups,
    },
  ];
}

// Un estado de instalación vive en memoria del agente: es de esta corrida, no
// un dato que deba sobrevivir a un reinicio.
let install = { status: 'idle', percent: 0, message: null, error: null };

export function browserInstallState() {
  return { ...install };
}

export async function startBrowserInstall() {
  if (install.status === 'running') return browserInstallState();
  install = { status: 'running', percent: 0, message: 'Preparando la descarga…', error: null };
  const promise = installBrowser({
    onProgress: (percent, text) => {
      install = { ...install, percent, message: text };
    },
    onLog: (text) => {
      install = { ...install, message: text };
    },
  })
    .then(() => {
      install = { status: 'done', percent: 100, message: 'Browser listo', error: null };
    })
    .catch((error) => {
      install = { status: 'error', percent: install.percent, message: null, error: error.message };
    });
  // La instalación sigue en el agente aunque el navegador cierre la pestaña:
  // el estado se consulta después. No se espera acá.
  promise.catch(() => {});
  return browserInstallState();
}

function hasAccount() {
  const row = db.prepare('SELECT portal_username FROM users WHERE id = ?').get(LOCAL_USER_ID);
  return Boolean(row?.portal_username);
}

/**
 * El estado completo del primer uso. Es público (se sirve antes del login)
 * y por eso no devuelve ningún dato académico ni el usuario del portal.
 */
export async function onboardingState() {
  const mode = runtimeMode();
  const browser = await browserStatus();
  const checks = prerequisites();
  const account = hasAccount();
  const completedAt = readMeta(COMPLETED_KEY);

  const step = !mode
    ? 'mode'
    : !checks.every((check) => check.ok)
      ? 'prerequisites'
      : !browser.installed
        ? 'browser'
        : !account
          ? 'credentials'
          : 'done';

  return {
    step,
    completedAt,
    mode,
    modes: Object.values(MODES),
    prerequisites: checks,
    browser: { installed: browser.installed, root: browser.root, source: browser.source, install: browserInstallState() },
    account,
  };
}

export function markOnboardingComplete(now = new Date()) {
  return writeMeta(COMPLETED_KEY, now.toISOString());
}
