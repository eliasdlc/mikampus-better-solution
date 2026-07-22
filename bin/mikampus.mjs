#!/usr/bin/env node
// npm is deliberately a foreground entrypoint: `npx mikampus` ends when the
// terminal ends.  A durable agent is an explicit opt-in through install-service.
import '../dist/app/launcher.js';
