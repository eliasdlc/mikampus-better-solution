import assert from 'node:assert/strict';
import path from 'node:path';
import { defaultDataDir, dataPaths } from '../src/paths.js';

assert.equal(defaultDataDir('win32', { APPDATA: 'C:\\Users\\Ana\\AppData\\Roaming' }, 'C:\\Users\\Ana'), path.win32.join('C:\\Users\\Ana\\AppData\\Roaming', 'mikampus'));
assert.equal(defaultDataDir('darwin', {}, '/Users/ana'), '/Users/ana/Library/Application Support/mikampus');
assert.equal(defaultDataDir('linux', { XDG_DATA_HOME: '/data' }, '/home/ana'), '/data/mikampus');
const paths = dataPaths({ MIKAMPUS_DATA_DIR: '/private/mikampus' });
assert.equal(paths.db, '/private/mikampus/mikampus.db');
assert.equal(paths.browsers, '/private/mikampus/browsers');
console.log('✓ paths: app-data por OS, sin dependencia del CWD');
