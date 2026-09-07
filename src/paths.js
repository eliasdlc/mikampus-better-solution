import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// All persistent state has one owner.  In a packaged app `MIKAMPUS_RESOURCE_DIR`
// points at the read-only application payload; in a checkout it naturally points
// at the repository root.  Neither case depends on the caller's working dir.
export const resourceRoot = path.resolve(process.env.MIKAMPUS_RESOURCE_DIR || path.join(moduleDir, '..'));

export function defaultDataDir(platform = process.platform, env = process.env, home = os.homedir()) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (env.MIKAMPUS_DATA_DIR) return paths.resolve(env.MIKAMPUS_DATA_DIR);
  if (platform === 'win32') return paths.join(env.APPDATA || paths.join(home, 'AppData', 'Roaming'), 'mikampus');
  if (platform === 'darwin') return paths.join(home, 'Library', 'Application Support', 'mikampus');
  return paths.join(env.XDG_DATA_HOME || paths.join(home, '.local', 'share'), 'mikampus');
}

export function dataPaths(env = process.env) {
  const dataDir = defaultDataDir(process.platform, env);
  return {
    dataDir,
    db: path.resolve(env.MIKAMPUS_DB || path.join(dataDir, 'mikampus.db')),
    credentials: path.resolve(env.MIKAMPUS_CREDENTIALS_FILE || path.join(dataDir, 'credenciales.env')),
    backups: path.resolve(env.MIKAMPUS_BACKUP_DIR || path.join(dataDir, 'backups')),
    runtime: path.resolve(env.MIKAMPUS_RUNTIME_DIR || path.join(dataDir, 'runtime')),
    // El espejo local de los materiales de la PVA. Fuera de la base a
    // propósito: son binarios, se deduplican por sha256 y no tienen por qué
    // engordar cada copia de seguridad de mikampus.db.
    pvaFiles: path.resolve(env.MIKAMPUS_PVA_FILES_DIR || path.join(dataDir, 'pva')),
    browsers: path.resolve(env.PLAYWRIGHT_BROWSERS_PATH || path.join(dataDir, 'browsers')),
  };
}

export function configureRuntimePaths(env = process.env) {
  const paths = dataPaths(env);
  env.MIKAMPUS_DATA_DIR ??= paths.dataDir;
  env.MIKAMPUS_DB ??= paths.db;
  env.MIKAMPUS_CREDENTIALS_FILE ??= paths.credentials;
  env.MIKAMPUS_BACKUP_DIR ??= paths.backups;
  env.MIKAMPUS_RUNTIME_DIR ??= paths.runtime;
  env.MIKAMPUS_PVA_FILES_DIR ??= paths.pvaFiles;
  env.PLAYWRIGHT_BROWSERS_PATH ??= paths.browsers;
  return paths;
}

export function resourcePath(...segments) {
  return path.join(resourceRoot, ...segments);
}
