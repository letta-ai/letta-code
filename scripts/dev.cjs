#!/usr/bin/env node

const { spawn } = require('node:child_process');

const env = { ...process.env };
if (!env.LETTA_DEBUG) env.LETTA_DEBUG = '1';
if (!env.LETTA_RESPONSES_WS) env.LETTA_RESPONSES_WS = '1';

const bunArgs = [
  '--loader=.md:text',
  '--loader=.mdx:text',
  '--loader=.txt:text',
  'run',
  'src/index.ts',
  ...process.argv.slice(2),
];

const child = spawn('bun', bunArgs, {
  stdio: 'inherit',
  env,
  windowsHide: true,
});

child.on('error', (error) => {
  console.error('failed to launch bun for dev mode:', error.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});