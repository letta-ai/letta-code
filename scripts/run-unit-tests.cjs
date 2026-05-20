#!/usr/bin/env node
const { execSync } = require("node:child_process");

// Unit test directories — bun discovers *.test.ts / *.test.tsx within each.
// Listed explicitly so we skip src/integration-tests (API-gated) and avoid
// shell expansion that can exceed the Windows command-line length limit.
const dirs = [
  "src/agent",
  "src/auth",
  "src/backend",
  "src/channels",
  "src/cli",
  "src/cron",
  "src/experiments",
  "src/hooks",
  "src/lsp",
  "src/permissions",
  "src/providers",
  "src/queue",
  "src/ralph",
  "src/reminders",
  "src/skills",
  "src/telemetry",
  "src/test-utils",
  "src/tools",
  "src/types",
  "src/updater",
  "src/utils",
  "src/websocket",
  // Root-level test files (not inside a subdirectory)
  "src/*.test.ts",
];

try {
  execSync(`bun test ${dirs.join(" ")} --timeout 15000`, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
} catch (e) {
  process.exit(e.status ?? 1);
}
