import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifact = path.join(root, 'build', `mikampus-${process.platform}-${process.arch}`);
const dist = path.join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(path.join(artifact, 'app'), path.join(dist, 'app'), { recursive: true });
await cp(path.join(artifact, 'public'), path.join(dist, 'public'), { recursive: true });
