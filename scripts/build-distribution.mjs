import crypto from 'node:crypto';
import { cp, chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const target = `${process.platform}-${process.arch}`;
if (target !== 'linux-x64') throw new Error(`No hay distribuci\u00f3n soportada para ${target}; RC1 solo publica Linux x64.`);
const version = pkg.version;
const name = `mikampus-v${version}-${target}`;
const out = path.join(root, 'release');
const stage = path.join(out, name);
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} termin\u00f3 con ${code}`)));
  });
}

await run(process.execPath, [path.join(root, 'scripts', 'build-production.mjs')]);
const artifact = path.join(root, 'build', `mikampus-${target}`);
await rm(stage, { recursive: true, force: true });
await mkdir(path.join(stage, 'payload'), { recursive: true });
await cp(path.join(artifact, 'app'), path.join(stage, 'payload', 'app'), { recursive: true });
await cp(path.join(artifact, 'public'), path.join(stage, 'payload', 'public'), { recursive: true });
await cp(path.join(artifact, 'node_modules'), path.join(stage, 'payload', 'node_modules'), { recursive: true });
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES', 'README.md', 'package.json']) await cp(path.join(artifact, file), path.join(stage, 'payload', file));
await cp(process.execPath, path.join(stage, 'payload', 'node'));
await chmod(path.join(stage, 'payload', 'node'), 0o755);

const launcher = `#!/bin/sh
set -eu
ROOT=\"\${MIKAMPUS_INSTALL_ROOT:-$HOME/.local/share/mikampus}\"
export MIKAMPUS_RESOURCE_DIR=\"$ROOT/current\"
if [ \"$#\" -eq 0 ]; then set -- cli open; else set -- cli \"$@\"; fi
exec \"$ROOT/current/node\" \"$ROOT/current/app/launcher.js\" \"$@\"
`;
const install = `#!/bin/sh
set -eu
PREFIX=\"\${MIKAMPUS_INSTALL_ROOT:-$HOME/.local/share/mikampus}\"
BIN=\"\${MIKAMPUS_BIN_DIR:-$HOME/.local/bin}\"
PAYLOAD=\"$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)/payload\"
VERSION=\"${version}\"
NO_SERVICE=0
[ \"\${1:-}\" = \"--no-service\" ] && NO_SERVICE=1
mkdir -p \"$PREFIX/versions\" \"$BIN\"
if [ -x \"$BIN/mikampus\" ]; then \"$BIN/mikampus\" stop || true; \"$BIN/mikampus\" backup || true; fi
rm -rf \"$PREFIX/versions/$VERSION\"
cp -R \"$PAYLOAD\" \"$PREFIX/versions/$VERSION\"
ln -sfn \"$PREFIX/versions/$VERSION\" \"$PREFIX/current\"
cat > \"$BIN/mikampus\" <<'EOF'
${launcher}
EOF
chmod 755 \"$BIN/mikampus\"
if [ \"$NO_SERVICE\" -eq 0 ]; then \"$BIN/mikampus\" install-service; fi
printf '%s\\n' \"mikampus $VERSION instalado. Ejecut\u00e1 mikampus para abrirlo; ejecut\u00e1 mikampus install-browser para completar el primer uso.\"
`;
const uninstall = `#!/bin/sh
set -eu
PREFIX=\"\${MIKAMPUS_INSTALL_ROOT:-$HOME/.local/share/mikampus}\"
BIN=\"\${MIKAMPUS_BIN_DIR:-$HOME/.local/bin}\"
DATA=\"\${MIKAMPUS_DATA_DIR:-\${XDG_DATA_HOME:-$HOME/.local/share}/mikampus}\"
if [ -x \"$BIN/mikampus\" ]; then \"$BIN/mikampus\" uninstall-service || true; \"$BIN/mikampus\" stop || true; fi
printf '%s\\n' \"Se retirar\u00e1 el launcher y el core en $PREFIX.\"
printf '¿Borrar tambi\u00e9n los datos locales en %s? [s/N] ' \"$DATA\"
read answer || answer=n
rm -rf \"$PREFIX\" \"$BIN/mikampus\"
case \"$answer\" in s|S|si|SI|s\u00ed|S\u00cd) rm -rf \"$DATA\"; printf '%s\\n' 'Datos locales borrados.' ;; *) printf '%s\\n' 'Datos locales preservados.' ;; esac
`;
await writeFile(path.join(stage, 'install.sh'), install, { mode: 0o755 });
await writeFile(path.join(stage, 'uninstall.sh'), uninstall, { mode: 0o755 });
await writeFile(path.join(stage, 'INSTALL.md'), '# mikampus ' + version + ' — Linux x64\\n\\nSoportado en Ubuntu 24.04 y Debian 12 x64. No hay binario para Windows, macOS ni ARM en este RC.\\n\\n1. Verificá el archivo con el SHA-256 publicado en SHA256SUMS.\\n2. Extraé: tar -xzf ' + name + '.tar.gz.\\n3. Ejecutá: ./' + name + '/install.sh. Agregá ~/.local/bin a PATH si hace falta.\\n4. Ejecutá mikampus para abrir la instancia y completá el primer uso.\\n\\nEl binario no está firmado. Linux no tiene un equivalente universal de Gatekeeper/SmartScreen: verificá SHA-256 y la procedencia antes de ejecutarlo. El instalador crea un servicio de usuario systemd; usá ./uninstall.sh para retirarlo y elegir si preservás los datos.\\n');

const inventory = Object.entries(pkg.dependencies).map(([name, versionRange]) => ({ name, versionRange }));
const provenance = { _type: 'https://slsa.dev/provenance/v1', subject: [{ name: `${name}.tar.gz` }], buildDefinition: { buildType: 'mikampus/local-distribution', externalParameters: { version, target }, internalParameters: { node: process.version, platform: `${os.platform()}-${os.arch()}` }, resolvedDependencies: [{ uri: 'git+local', digest: { sha1: process.env.GITHUB_SHA || 'local' } }] } };
await writeFile(path.join(stage, 'SBOM.json'), JSON.stringify({ spdxVersion: 'SPDX-2.3', name: 'mikampus', versionInfo: version, packages: inventory }, null, 2) + '\n');
await writeFile(path.join(stage, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES']) await cp(path.join(root, file), path.join(stage, file));
const archive = path.join(out, `${name}.tar.gz`);
await run('tar', ['-C', out, '-czf', archive, name]);
const files = [path.basename(archive), ...['INSTALL.md', 'LICENSE', 'THIRD_PARTY_NOTICES', 'SBOM.json', 'provenance.json'].map((file) => `${name}/${file}`)];
const sums = files.map((file) => `${sha256(path.join(out, file))}  ${file}`).join('\n') + '\n';
await writeFile(path.join(out, 'SHA256SUMS'), sums);
console.log(`Distribuci\u00f3n lista: ${archive} (${(await stat(archive)).size} bytes)`);
