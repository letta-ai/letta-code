#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = mkdtempSync(join(tmpdir(), "letta-code-minimal-linux-npm-"));
const imageTag = `letta-code-minimal-linux-npm:${process.pid}`;
const platform = "linux/amd64";
const dockerNodeVersion = "$" + "{NODE_VERSION}";
const dockerNodeArch = "$" + "{node_arch}";
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

const dockerfile = String.raw`
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_VERSION=22.19.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) node_arch="x64" ;; \
    arm64) node_arch="arm64" ;; \
    *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://nodejs.org/dist/v${dockerNodeVersion}/node-v${dockerNodeVersion}-linux-${dockerNodeArch}.tar.xz" -o /tmp/node.tar.xz; \
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1; \
  rm /tmp/node.tar.xz; \
  node --version; \
  npm --version; \
  if command -v make >/dev/null 2>&1; then \
    echo "make unexpectedly present in minimal image" >&2; \
    exit 1; \
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
node <<'NODE'
const { createRequire } = require("node:module");
const requireFromLetta = createRequire(require.resolve("@letta-ai/letta-code"));
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
  run("docker", ["version"], { stdio: "ignore" });
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
  console.log("Minimal Linux packed artifact check passed");
} finally {
  try {
    execFileSync("docker", ["rmi", "-f", imageTag], { stdio: "ignore" });
  } catch {}
  rmSync(tempDir, { recursive: true, force: true });
}
