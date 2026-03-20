#!/usr/bin/env node
/**
 * Compile and install the patched spawn-helper for node-pty.
 *
 * Replaces node-pty's prebuilt spawn-helper binaries (darwin-arm64 and
 * darwin-x64) with a version that is compatible with macOS 26+ (Tahoe).
 * Safe to run on older macOS — the patch is backwards-compatible.
 *
 * Skipped on non-macOS platforms (spawn-helper is macOS/Linux only and
 * the prebuilds dir won't exist on Windows).
 */
'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

if (os.platform() !== 'darwin') {
  process.exit(0);
}

const srcFile = path.join(__dirname, 'spawn-helper.cc');

const nodePtyRoot = path.join(
  __dirname, '..', 'node_modules', 'node-pty',
);

if (!fs.existsSync(nodePtyRoot)) {
  console.log('letta: node-pty not found, skipping spawn-helper patch');
  process.exit(0);
}

// Targets: one compiled binary per arch — works for both arm64 and x64.
const targets = [
  {
    arch: 'arm64',
    dest: path.join(nodePtyRoot, 'prebuilds', 'darwin-arm64', 'spawn-helper'),
    clangArch: 'arm64',
  },
  {
    arch: 'x64',
    dest: path.join(nodePtyRoot, 'prebuilds', 'darwin-x64', 'spawn-helper'),
    clangArch: 'x86_64',
  },
];

let patched = 0;

for (const { arch, dest, clangArch } of targets) {
  if (!fs.existsSync(path.dirname(dest))) {
    continue; // prebuilds dir for this arch not present
  }

  const tmp = path.join(os.tmpdir(), `spawn-helper-${arch}-${Date.now()}`);
  try {
    execSync(
      `clang -arch ${clangArch} -o "${tmp}" "${srcFile}"`,
      { stdio: 'pipe' },
    );
    fs.chmodSync(tmp, 0o755);
    fs.copyFileSync(tmp, dest);
    fs.chmodSync(dest, 0o755);
    fs.unlinkSync(tmp);
    console.log(`letta: patched spawn-helper for darwin-${arch}`);
    patched++;
  } catch (err) {
    console.warn(`letta: could not compile spawn-helper for darwin-${arch}: ${err.message}`);
  }
}

if (patched === 0) {
  console.log('letta: no spawn-helper targets patched (clang may be missing)');
}
