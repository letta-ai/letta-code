#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { readFileSync, readdirSync } = require("node:fs");
const path = require("node:path");

// Unit test directories — bun discovers *.test.ts / *.test.tsx within each.
// Listed explicitly so we skip src/integration-tests (API-gated).
const dirs = [
  "src/agent",
  "src/auth",
  "src/backend",
  "src/cli",
  "src/cron",
  "src/experiments",
  "src/helpers",
  "src/hooks",
  "src/lsp",
  "src/mods",
  "src/permissions",
  "src/providers",
  "src/queue",
  "src/reminders",
  "src/sandbox",
  "src/skills",
  "src/telemetry",
  "src/test-utils",
  "src/tools",
  "src/types",
  "src/updater",
  "src/utils",
  "src/web",
  "src/websocket",
];

const isolationManifest = JSON.parse(
  readFileSync(path.join(__dirname, "isolated-unit-tests.json"), "utf8"),
);
const isolatedTests = isolationManifest.tests;
const isolatedPaths = new Set(isolatedTests.map((entry) => entry.path));

function findTestFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findTestFiles(full));
    } else if (
      entry.name.endsWith(".test.ts") ||
      entry.name.endsWith(".test.tsx")
    ) {
      results.push(full.replace(/\\/g, "/"));
    }
  }
  return results;
}

function findRootTestFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")),
    )
    .map((entry) => path.join(dir, entry.name).replace(/\\/g, "/"));
}

const allTestFiles = [
  ...dirs.flatMap((dir) => findTestFiles(dir)),
  ...findTestFiles("src/channels"),
  ...findRootTestFiles("src"),
].sort();
const discoveredPaths = new Set(allTestFiles);

for (const entry of isolatedTests) {
  if (!discoveredPaths.has(entry.path)) {
    throw new Error(
      `Isolated unit test is missing from the unit-test roots: ${entry.path}`,
    );
  }
  if (!Number.isInteger(entry.timeoutMs) || entry.timeoutMs <= 0) {
    throw new Error(`Invalid timeout for isolated unit test: ${entry.path}`);
  }
}

function runTests(files, timeoutMs) {
  execFileSync("bun", ["test", ...files, "--timeout", String(timeoutMs)], {
    stdio: "inherit",
    // Unit tests must never emit product telemetry or make test fixtures look
    // like real users. Override any inherited opt-in from the parent shell.
    env: { ...process.env, LETTA_CODE_TELEM: "0" },
  });
}

function chunkByCommandLength(files, maxChars = 20000) {
  const chunks = [];
  let chunk = [];
  let chars = 0;

  for (const file of files) {
    const nextChars = file.length + 3;
    if (chunk.length > 0 && chars + nextChars > maxChars) {
      chunks.push(chunk);
      chunk = [];
      chars = 0;
    }
    chunk.push(file);
    chars += nextChars;
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
}

let exitCode = 0;

// Bun module mocks and process-global state are shared within one test process.
// Keep the explicitly stateful suites in fresh processes so they cannot poison
// the ordinary unit batch or inherit another suite's cwd/env/module registry.
for (const entry of isolatedTests) {
  try {
    runTests([entry.path], entry.timeoutMs);
  } catch (error) {
    exitCode = error.status ?? 1;
  }
}

const sharedProcessTests = allTestFiles.filter(
  (file) => !isolatedPaths.has(file),
);

// Passing argv directly avoids cmd.exe's shorter shell command-line limit on
// Windows. Bounded batches also stay below CreateProcess's 32k limit as the
// suite grows.
for (const batch of chunkByCommandLength(sharedProcessTests)) {
  try {
    runTests(batch, 15000);
  } catch (error) {
    exitCode = error.status ?? 1;
  }
}

process.exit(exitCode);
