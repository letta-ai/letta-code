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

// Slack media and interop tests install process-global module mocks. In Bun 1.3.x
// those mocks can poison sibling Slack adapter tests in the shared module registry.
// Run both in isolated processes, then run the remaining channel tests together.
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

const isolatedChannelTests = [
  "src/channels/slack-media.test.ts",
  "src/channels/slack-adapter-interop.test.ts",
];
const channelTestFiles = findTestFiles("src/channels", isolatedChannelTests);

const opts = { stdio: "inherit", shell: process.platform === "win32" };
let exitCode = 0;

// Give each process-global Slack mock a clean module registry.
for (const testFile of isolatedChannelTests) {
  try {
    execSync(`bun test ${testFile} --timeout 15000`, opts);
  } catch (e) {
    exitCode = e.status ?? 1;
  }
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
