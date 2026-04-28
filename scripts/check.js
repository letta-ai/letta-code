#!/usr/bin/env bun
// Script to run linting and type checking with helpful error messages

import { $ } from "bun";

console.log("🔍 Running lint and type checks...\n");

let failed = false;

// Run test mock isolation check
console.log("🧪 Checking Bun module mock isolation...");
try {
  await $`bun run check:test-mock-isolation`;
  console.log("✅ Mock isolation check passed\n");
} catch (error) {
  console.error("❌ Mock isolation check failed\n");
  console.error(
    "Add a top-level mock.restore() teardown hook to any test file using mock.module(), or remove the module mock.\n",
  );
  failed = true;
}

// Run lint
console.log("📝 Running Biome linter...");
try {
  await $`bun run lint`;
  console.log("✅ Linting passed\n");
} catch (error) {
  console.error("❌ Linting failed\n");
  console.error("To fix automatically, run:");
  console.error("  bun run fix\n");
  failed = true;
}

// Run typecheck
console.log("🔎 Running TypeScript type checker...");
try {
  await $`bun run typecheck`;
  console.log("✅ Type checking passed\n");
} catch (error) {
  console.error("❌ Type checking failed\n");
  console.error("Fix the type errors shown above, then run:");
  console.error("  bun run typecheck\n");
  failed = true;
}

if (failed) {
  console.error("❌ Checks failed. Please fix the errors above.");
  console.error("\nQuick commands:");
  console.error("  bun run fix       # Auto-fix linting issues");
  console.error("  bun run typecheck # Check types only");
  console.error("  bun run check     # Run both checks");
  process.exit(1);
}

console.log("✅ All checks passed!");
