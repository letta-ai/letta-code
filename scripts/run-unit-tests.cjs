#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { readFileSync, readdirSync } = require("node:fs");
const path = require("node:path");
const {
  buildFamilyImpactIndex,
  getGitChangedFiles,
  planUnitTests,
  readPullRequestShas,
} = require("./unit-test-impact.cjs");

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
  ...findTestFiles("scripts/codex-watch"),
  ...findTestFiles("scripts/claude-watch"),
  "scripts/unit-test-impact.test.cjs",
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

function runTests(files, timeoutMs, env = {}) {
  execFileSync("bun", ["test", ...files, "--timeout", String(timeoutMs)], {
    stdio: "inherit",
    // Unit tests must never emit product telemetry or make test fixtures look
    // like real users. Only isolated telemetry contract tests may opt back in.
    env: { ...process.env, LETTA_CODE_TELEM: "0", ...env },
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

function readSelectionShas() {
  const baseIndex = process.argv.indexOf("--base");
  const headIndex = process.argv.indexOf("--head");
  if (baseIndex !== -1 || headIndex !== -1) {
    if (baseIndex === -1 || headIndex === -1) {
      throw new Error("Both --base and --head are required");
    }
    const baseSha = process.argv[baseIndex + 1];
    const headSha = process.argv[headIndex + 1];
    if (!baseSha || !headSha) {
      throw new Error("Both --base and --head are required");
    }
    return { baseSha, headSha };
  }

  if (process.env.GITHUB_EVENT_NAME !== "pull_request") {
    return null;
  }
  if (!process.env.GITHUB_EVENT_PATH) {
    throw new Error("GITHUB_EVENT_PATH is required for pull request selection");
  }
  return readPullRequestShas(process.env.GITHUB_EVENT_PATH);
}

function selectTestFiles() {
  let shas;
  try {
    shas = readSelectionShas();
  } catch (error) {
    console.warn(
      `unit-test impact: running all tests because selection setup failed: ${error.message}`,
    );
    return allTestFiles;
  }

  if (!shas) {
    console.log(
      `unit-test impact: running all ${allTestFiles.length} tests outside a pull request`,
    );
    return allTestFiles;
  }

  try {
    const plan = planUnitTests({
      changedFiles: getGitChangedFiles(shas.baseSha, shas.headSha),
      allTestFiles,
      impactIndex: buildFamilyImpactIndex(),
    });
    console.log(
      `unit-test impact: ${plan.selectedTests.length}/${allTestFiles.length} tests (${plan.reason})`,
    );
    for (const selection of plan.selectedFamilies) {
      const shownReasons = selection.reasons.slice(0, 3);
      const hiddenReasonCount = selection.reasons.length - shownReasons.length;
      const suffix =
        hiddenReasonCount > 0 ? `; +${hiddenReasonCount} more` : "";
      console.log(`  ${selection.family}: ${shownReasons.join("; ")}${suffix}`);
    }
    if (plan.omittedTests.length > 0) {
      console.log(`  omitted: ${plan.omittedTests.length} unrelated tests`);
    }
    return plan.selectedTests;
  } catch (error) {
    console.warn(
      `unit-test impact: running all tests because planning failed: ${error.message}`,
    );
    return allTestFiles;
  }
}

let exitCode = 0;
const selectedTestFiles = selectTestFiles();
const selectedTestPaths = new Set(selectedTestFiles);

// Bun module mocks and process-global state are shared within one test process.
// Keep the explicitly stateful suites in fresh processes so they cannot poison
// the ordinary unit batch or inherit another suite's cwd/env/module registry.
for (const entry of isolatedTests.filter((entry) =>
  selectedTestPaths.has(entry.path),
)) {
  try {
    runTests([entry.path], entry.timeoutMs, entry.env);
  } catch (error) {
    exitCode = error.status ?? 1;
  }
}

const sharedProcessTests = selectedTestFiles.filter(
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
