#!/usr/bin/env node

/**
 * Detects test files (*.test.ts, *.test.tsx) under src/ that are NOT covered
 * by the CI unit test runner (scripts/run-unit-tests.cjs).
 *
 * This catches two problems:
 *   1. A new src/ directory gets test files but nobody updates the dirs list
 *      in run-unit-tests.cjs, so those tests silently stop running in CI.
 *   2. Tests are added to forbidden directories (e.g. src/tests) instead of
 *      being collocated with their source files.
 *
 * Excluded by design:
 *   src/integration-tests — API-gated, run separately in CI
 *   src/channels — special-cased in run-unit-tests.cjs (isolation requirements)
 */

const { readdirSync, existsSync } = require("node:fs");
const path = require("node:path");

// ---- Collect all test files under src/ ----
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

const allTestFiles = findTestFiles("src");

// ---- Forbidden directories ----
// Tests must be collocated with their source (e.g. src/cli/components/Foo.test.tsx),
// not in a separate test directory.
const FORBIDDEN_DIRS = ["src/tests"];

const forbiddenFiles = allTestFiles.filter((f) =>
  FORBIDDEN_DIRS.some(
    (prefix) => f === prefix || f.startsWith(prefix + "/"),
  ),
);

if (forbiddenFiles.length > 0) {
  console.error(
    `check-test-coverage: ${forbiddenFiles.length} test file(s) in forbidden directory:`,
  );
  for (const file of forbiddenFiles) {
    console.error(`  ${file}`);
  }
  console.error(
    "\nTests must be collocated with their source files, not in src/tests/.",
  );
  console.error(
    "Move the test next to the module it tests (e.g. src/cli/components/Foo.test.tsx).",
  );
  process.exit(1);
}

// ---- Determine which directories/patterns CI covers ----
// These must match scripts/run-unit-tests.cjs
const ciDirs = [
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
];

// Special cases: channels is run separately, integration-tests is API-gated
const specialDirs = ["src/channels", "src/integration-tests"];

// Root-level: src/*.test.ts is covered by glob
const coveredPrefixes = [...ciDirs, ...specialDirs];

function isCovered(file) {
  // Root-level src/*.test.ts files (no subdirectory)
  if (/^src\/[^/]+\.test\.tsx?$/.test(file)) return true;

  return coveredPrefixes.some(
    (prefix) => file === prefix || file.startsWith(prefix + "/"),
  );
}

// ---- Report ----
const uncovered = allTestFiles.filter((f) => !isCovered(f));

if (uncovered.length === 0) {
  console.log(
    `check-test-coverage: all ${allTestFiles.length} test files are covered by CI`,
  );
  process.exit(0);
}

console.error(
  `check-test-coverage: ${uncovered.length} test file(s) not covered by CI:`,
);
for (const file of uncovered) {
  console.error(`  ${file}`);
}
console.error(
  "\nAdd the parent directory to the 'dirs' list in scripts/run-unit-tests.cjs,",
);
console.error(
  "or add it to 'specialDirs' in scripts/check-test-coverage.cjs if it's run separately.",
);
process.exit(1);
