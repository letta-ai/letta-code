#!/usr/bin/env node


const { readdirSync, existsSync } = require("node:fs");
const path = require("node:path");

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

const ciDirs = [
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
  "src/usage",
  "src/web",
  "src/websocket",
];

const specialDirs = ["src/channels", "src/integration-tests"];

const coveredPrefixes = [...ciDirs, ...specialDirs];

function isCovered(file) {
  if (/^src\/[^/]+\.test\.tsx?$/.test(file)) return true;

  return coveredPrefixes.some(
    (prefix) => file === prefix || file.startsWith(prefix + "/"),
  );
}

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
