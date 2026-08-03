#!/usr/bin/env node

/**
 * Installs the packed npm artifact into a minimal Ubuntu image that has no C++
 * toolchain (no make, no python3) and proves that:
 *   1. `npm install` succeeds — i.e. node-pty resolved a prebuilt binary
 *      instead of falling back to `node-gyp rebuild`.
 *   2. The installed CLI runs (`letta --help` produces real output).
 *   3. node-pty loads and allocates an actual TTY.
 *
 * Regression guard for letta-ai/letta-acp#50, where `npx @letta-ai/letta-code`
 * failed on minimal Ubuntu images with `Error: not found: make`.
 *
 * Usage:
 *   node scripts/check-minimal-linux-npm-artifact.js [--skip-build] [--platform=linux/arm64]
 *
 * Env:
 *   LETTA_CODE_MINIMAL_LINUX_ARTIFACT_SKIP_BUILD=1  reuse existing build output
 *   LETTA_CODE_MINIMAL_LINUX_ARTIFACT_PLATFORM      docker platform override
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = mkdtempSync(join(tmpdir(), "letta-code-minimal-linux-npm-"));
const imageTag = `letta-code-minimal-linux-npm:${process.pid}`;
const nodeVersion = "22.19.0";

const NODE_ARCH_BY_PLATFORM = {
  "linux/amd64": "x64",
  "linux/arm64": "arm64",
};

function resolvePlatform() {
  const flag = process.argv.find((arg) => arg.startsWith("--platform="));
  const requested =
    flag?.slice("--platform=".length) ||
    process.env.LETTA_CODE_MINIMAL_LINUX_ARTIFACT_PLATFORM ||
    (process.arch === "arm64" ? "linux/arm64" : "linux/amd64");
  if (!NODE_ARCH_BY_PLATFORM[requested]) {
    throw new Error(
      `Unsupported platform "${requested}". Expected one of: ${Object.keys(NODE_ARCH_BY_PLATFORM).join(", ")}`,
    );
  }
  return requested;
}

const platform = resolvePlatform();
const nodeArch = NODE_ARCH_BY_PLATFORM[platform];
const skipBuild =
  process.argv.includes("--skip-build") ||
  process.env.LETTA_CODE_MINIMAL_LINUX_ARTIFACT_SKIP_BUILD === "1";

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  execFileSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    timeout: 10 * 60 * 1000,
    ...options,
  });
}

function capture(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 10 * 60 * 1000,
    ...options,
  });
}

function assertDockerAvailable() {
  try {
    execFileSync("docker", ["version"], { stdio: "ignore", timeout: 60_000 });
  } catch (error) {
    throw new Error(
      "Docker is required for check:minimal-linux-npm-artifact but `docker version` failed. " +
        "Install Docker and make sure the daemon is running, then re-run. " +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// The image deliberately omits make/python3 so a node-gyp fallback fails loudly.
const dockerfile = `
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \\
  && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \\
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \\
  curl -fsSL "https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-linux-${nodeArch}.tar.xz" -o /tmp/node.tar.xz; \\
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1; \\
  rm /tmp/node.tar.xz; \\
  node --version; \\
  npm --version; \\
  if command -v make >/dev/null 2>&1; then \\
    echo "make unexpectedly present in minimal image" >&2; \\
    exit 1; \\
  fi

WORKDIR /workspace
`;

const ptySmoke = `
set -eux
if command -v make >/dev/null 2>&1; then
  echo "make unexpectedly present before npm install" >&2
  exit 1
fi
mkdir -p /workspace/app
cd /workspace/app
npm init -y >/dev/null
npm install --omit=dev --foreground-scripts /tmp/letta-code.tgz
./node_modules/.bin/letta --help >/tmp/letta-help.txt
grep -q letta /tmp/letta-help.txt || {
  echo "letta --help produced no recognizable output" >&2
  cat /tmp/letta-help.txt >&2
  exit 1
}
node <<'NODE'
const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { createRequire } = require("node:module");
const requireFromLetta = createRequire(require.resolve("@letta-ai/letta-code"));
const ptyRoot = dirname(requireFromLetta.resolve("node-pty/package.json"));

// A prebuild directory for this platform is what keeps npm from shelling out to
// node-gyp; \`build/\` only exists when a source rebuild ran (it is not shipped
// in the tarball). Assert both so a future node-pty bump that drops prebuilds
// fails here rather than in a user's npx install.
const prebuildDir = join(
  ptyRoot,
  "prebuilds",
  process.platform + "-" + process.arch,
);
if (!existsSync(prebuildDir)) {
  console.error("node-pty is missing a prebuild at " + prebuildDir);
  process.exit(1);
}
if (existsSync(join(ptyRoot, "build"))) {
  console.error(
    "node-pty was rebuilt from source (" +
      join(ptyRoot, "build") +
      " exists); the prebuild was not used",
  );
  process.exit(1);
}
console.log("node-pty prebuild in use: " + prebuildDir);

const pty = requireFromLetta("node-pty");
const term = pty.spawn("/bin/bash", ["-lc", "test -t 0 && printf tty-ok"], {
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
  try { term.kill(); } catch {}
  console.error("PTY smoke timed out; output=" + JSON.stringify(output));
  process.exit(1);
}, 20000);
term.onData((data) => {
  output += data;
});
term.onExit(({ exitCode }) => {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  if (exitCode !== 0) {
    console.error(
      "PTY smoke exited with " + exitCode + "; output=" + JSON.stringify(output),
    );
    process.exit(1);
  }
  if (!output.includes("tty-ok")) {
    console.error(
      "PTY smoke did not allocate a tty; output=" + JSON.stringify(output),
    );
    process.exit(1);
  }
  console.log("PTY smoke passed");
});
NODE
`;

try {
  assertDockerAvailable();
  console.log(`Checking packed artifact on ${platform} (node ${nodeVersion})`);
  if (skipBuild) {
    console.log("$ bun run build (skipped; using existing build output)");
  } else {
    run("bun", ["run", "build"]);
  }

  const packOutput = capture("npm", [
    "pack",
    "--pack-destination",
    tempDir,
    "--json",
  ]);
  const packed = JSON.parse(packOutput);
  const filename = packed?.[0]?.filename;
  if (!filename) {
    throw new Error(`npm pack did not report a filename: ${packOutput}`);
  }
  const tarball = join(tempDir, filename);

  writeFileSync(join(tempDir, "Dockerfile"), dockerfile);
  run("docker", [
    "build",
    "--pull",
    "--platform",
    platform,
    "-t",
    imageTag,
    tempDir,
  ]);
  run("docker", [
    "run",
    "--rm",
    "--platform",
    platform,
    "-v",
    `${tarball}:/tmp/letta-code.tgz:ro`,
    imageTag,
    "sh",
    "-c",
    ptySmoke,
  ]);
  console.log(`Minimal Linux packed artifact check passed (${platform})`);
} finally {
  try {
    execFileSync("docker", ["rmi", "-f", imageTag], { stdio: "ignore" });
  } catch {}
  rmSync(tempDir, { recursive: true, force: true });
}
