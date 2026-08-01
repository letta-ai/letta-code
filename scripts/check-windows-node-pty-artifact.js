#!/usr/bin/env node

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const marker = "letta-node-pty-windows-ok";

if (process.platform !== "win32") {
  console.log(
    "Windows node-pty artifact check skipped on non-Windows platform",
  );
  process.exit(0);
}

const globalRoot = (
  process.env.LETTA_CODE_GLOBAL_NODE_MODULES ||
  execSync("npm root -g", { encoding: "utf8" })
).trim();
const packageJson = join(globalRoot, "@letta-ai", "letta-code", "package.json");

if (!existsSync(packageJson)) {
  throw new Error(
    `Expected global @letta-ai/letta-code package at ${packageJson}. Run the npm install flow before this check.`,
  );
}

const requireFromLetta = createRequire(packageJson);
const pty = requireFromLetta("node-pty");
const shell = process.env.ComSpec || "cmd.exe";
const term = pty.spawn(shell, ["/d", "/q"], {
  name: "xterm-256color",
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: { ...process.env, TERM: "xterm-256color" },
});

let output = "";
let settled = false;

const timeout = setTimeout(() => {
  if (settled) return;
  settled = true;
  try {
    term.kill();
  } catch {}
  console.error(
    `Windows node-pty smoke timed out; output=${JSON.stringify(output)}`,
  );
  process.exit(1);
}, 5000);

term.onData((data) => {
  output += data;
});

term.onExit(({ exitCode }) => {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  if (exitCode !== 0) {
    console.error(
      `Windows node-pty smoke exited with ${exitCode}; output=${JSON.stringify(output)}`,
    );
    process.exit(1);
  }
  if (!output.includes(marker)) {
    console.error(
      `Windows node-pty smoke did not see marker; output=${JSON.stringify(output)}`,
    );
    process.exit(1);
  }
  console.log("Windows node-pty PTY smoke passed");
});

term.write(`echo ${marker}\r\n`);
term.write("exit\r\n");
