#!/usr/bin/env node

/**
 * Proves the globally-installed npm artifact has a working ConPTY on Windows:
 * node-pty resolves from the installed package, ships a prebuild for this
 * platform, and a spawned shell actually executes what we write to it.
 *
 * Requires `npm install -g <tarball>` to have run first (the CI npm install
 * flow step does this).
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// `set /a` is evaluated by cmd itself, so the expected value cannot appear in
// the ConPTY echo of the input line. Asserting on an echoed literal would pass
// even if the shell never executed the command.
const expression = "6*7";
const expected = "42";

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
const ptyRoot = dirname(requireFromLetta.resolve("node-pty/package.json"));
const prebuildDir = join(
  ptyRoot,
  "prebuilds",
  `${process.platform}-${process.arch}`,
);

// Windows runners have MSVC, so a node-pty version that dropped Windows
// prebuilds would still pass the PTY smoke here via `node-gyp rebuild` while
// breaking every user without a toolchain. Assert the prebuild explicitly.
if (!existsSync(prebuildDir)) {
  throw new Error(
    `node-pty is missing a prebuild at ${prebuildDir}. Users without a C++ toolchain would fall back to node-gyp.`,
  );
}
console.log(`node-pty prebuild present: ${prebuildDir}`);

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
let sent = false;

function fail(message) {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  try {
    term.kill();
  } catch {}
  console.error(`${message}; output=${JSON.stringify(output)}`);
  process.exit(1);
}

// Cold Windows runners can take several seconds to attach the console.
const timeout = setTimeout(() => {
  fail("Windows node-pty smoke timed out");
}, 20_000);

term.onData((data) => {
  output += data;
  // ConPTY can drop input written before the console is attached, so wait for
  // the first byte from the shell (its prompt) before writing.
  if (!sent) {
    sent = true;
    term.write(`set /a ${expression}\r\n`);
    term.write("exit\r\n");
  }
});

term.onExit(({ exitCode }) => {
  if (settled) return;
  if (exitCode !== 0) {
    fail(`Windows node-pty smoke exited with ${exitCode}`);
    return;
  }
  if (!output.includes(expected)) {
    fail(
      `Windows node-pty smoke did not see evaluated result ${expected} for ${expression}`,
    );
    return;
  }
  settled = true;
  clearTimeout(timeout);
  // ConPTY can retain a native handle after the child exits. This is a one-shot
  // check, so exit explicitly once the PTY proof is complete.
  console.log("Windows node-pty PTY smoke passed");
  process.exit(0);
});
