#!/usr/bin/env node
const { execSync } = require("node:child_process");
const { readdirSync, statSync } = require("node:fs");
const path = require("node:path");

// Unit test directories — bun discovers *.test.ts / *.test.tsx within each.
// Listed explicitly so we skip src/integration-tests (API-gated) and avoid
// shell expansion that can exceed the Windows command-line length limit.
const dirs = [
  "src/agent",
  "src/auth",
  "src/backend",
  "src/cli",
  "src/cron",
  "src/experiments",
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
  // Root-level test files (not inside a subdirectory)
  "src/*.test.ts",
];

// slack/media.test.ts imports the real media module. The adapter test harness
// mocks that module, which in Bun 1.3.x poisons the shared module registry
// across parallel workers. Run media tests in an isolated process first, then
// run src/channels with every other test file.
function findTestFiles(dir, exclude) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findTestFiles(full, exclude));
    } else if (
      (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) &&
      !exclude.includes(full.replace(/\\/g, "/"))
    ) {
      results.push(full.replace(/\\/g, "/"));
    }
  }
  return results;
}

const channelTestFiles = findTestFiles("src/channels", [
  "src/channels/slack/media.test.ts",
]);

const opts = { stdio: "inherit", shell: process.platform === "win32" };
let exitCode = 0;

// Run Slack media tests in isolation first (clean module registry)
try {
  execSync("bun test src/channels/slack/media.test.ts --timeout 15000", opts);
} catch (e) {
  exitCode = e.status ?? 1;
}

// Run everything else
try {
  execSync(
    `bun test ${[...dirs, ...channelTestFiles].join(" ")} --timeout 15000`,
    opts,
  );
} catch (e) {
  exitCode = e.status ?? 1;
}

process.exit(exitCode);
