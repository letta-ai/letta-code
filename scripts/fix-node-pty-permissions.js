#!/usr/bin/env node
/**
 * Fix node-pty spawn-helper permissions.
 *
 * npm tarballs strip the execute bit from the prebuilt spawn-helper binary,
 * causing "posix_spawnp failed" errors on macOS and Linux.
 * See: https://github.com/microsoft/node-pty/issues/789
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

if (os.platform() === 'win32') {
  process.exit(0);
}

const prebuildsDir = path.join(
  __dirname, '..', 'node_modules', 'node-pty', 'prebuilds'
);

try {
  const platforms = fs.readdirSync(prebuildsDir);
  for (const platform of platforms) {
    const helperPath = path.join(prebuildsDir, platform, 'spawn-helper');
    try {
      fs.chmodSync(helperPath, 0o755);
      console.log(`letta: chmod +x ${helperPath}`);
    } catch (_) {
      // spawn-helper doesn't exist for this platform (e.g. win32) — skip
    }
  }
} catch (_) {
  // prebuilds dir doesn't exist (node-pty not yet installed) — skip
}
