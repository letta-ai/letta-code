#!/usr/bin/env bun
// Script to run linting and type checking with helpful error messages

import { $ } from "bun";

console.log("🔍 Running lint and type checks...\n");

let failed = false;

// Check for circular dependencies
console.log("🔄 Checking for circular dependencies...");
try {
  await $`bun run check:cycles --no-spinner`;
  console.log("✅ No circular dependencies\n");
} catch (error) {
  console.error("❌ Circular dependencies detected\n");
  console.error(
    "Fix the cycles shown above before merging. Run 'bun run check:cycles' locally.\n",
  );
  failed = true;
}

// Check architectural layer boundaries
console.log("🏗️  Checking layer boundaries...");
try {
  await $`bun run check:boundaries`;
  console.log("✅ Layer boundaries clean\n");
} catch (error) {
  console.error("❌ Layer boundary violations found\n");
  console.error(
    "Fix by moving the import to a shared layer (utils/, types/) or inverting the dependency.\n",
  );
  failed = true;
}

// Check exported function style
console.log("🔤 Checking exported function style...");
try {
  await $`bun run check:exported-functions`;
  console.log("✅ Exported function style clean\n");
} catch (error) {
  console.error("❌ Exported arrow functions found\n");
  console.error(
    "Use 'export function name() {}' instead of 'export const name = () =>'\n",
  );
  failed = true;
}

// Run test mock isolation check
console.log("🧪 Checking Bun module mock isolation...");
try {
  await $`bun run check:test-mock-isolation`;
  console.log("✅ Mock isolation check passed\n");
} catch (error) {
  console.error("❌ Mock isolation check failed\n");
  console.error(
    "Fix the unsafe mock.module() usage above. Prefer explicit test override helpers or scoped mocks with afterEach(mock.restore).\n",
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
