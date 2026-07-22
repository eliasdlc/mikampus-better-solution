#!/usr/bin/env node
// This is deliberately the only production entrypoint: paths must be fixed
// before `db.js` or Playwright are evaluated. Static imports cannot guarantee
// that ordering across their dependency graph.
import { configureRuntimePaths } from './paths.js';

configureRuntimePaths();
if (process.argv[2] === 'cli') {
  process.argv.splice(2, 1);
  await import('./cli.js');
} else {
  await import('./server.js');
}
