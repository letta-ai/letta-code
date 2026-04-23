#!/usr/bin/env bun

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const rootDir = process.cwd();
const testsDir = join(rootDir, "src", "tests");

function collectTestFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
      continue;
    }
    if (
      entry.isFile() &&
      (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx"))
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

const mockModulePattern = /\bmock\.module\s*\(\s*(["'`])([^"'`]+)\1/g;
const restoreHookPattern =
  /\bafter(?:All|Each)\s*\(\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>[\s\S]*?\bmock\.restore\s*\(/m;
const restoreHookFunctionPattern =
  /\bafter(?:All|Each)\s*\(\s*function\b[\s\S]*?\bmock\.restore\s*\(/m;

const failures = [];

for (const filePath of collectTestFiles(testsDir)) {
  const sourceText = readFileSync(filePath, "utf8");
  const mockedModules = Array.from(
    sourceText.matchAll(mockModulePattern),
    (match) => match[2] ?? "<dynamic module>",
  );

  if (mockedModules.length === 0) continue;

  const hasRestoreHook =
    restoreHookPattern.test(sourceText) ||
    restoreHookFunctionPattern.test(sourceText);
  if (hasRestoreHook) continue;

  failures.push({
    filePath,
    mockedModules,
  });
}

if (failures.length > 0) {
  console.error(
    "❌ Found test files that call mock.module() without a top-level afterEach/afterAll hook that calls mock.restore().\n",
  );

  for (const failure of failures) {
    const relPath = relative(rootDir, failure.filePath);
    console.error(`- ${relPath}`);
    console.error(`  mocked modules: ${failure.mockedModules.join(", ")}`);
  }

  console.error(
    "\nWhy this fails: Bun module mocks are process-global and can leak across files in the shared module cache.",
  );
  console.error(
    "Add a top-level afterEach(() => { mock.restore(); }) or afterAll(() => { mock.restore(); }) hook, or remove the module mock in favor of dependency injection.",
  );
  process.exit(1);
}

console.log("✅ No unguarded mock.module() usage found.");
