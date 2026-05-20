#!/usr/bin/env node
/**
 * Enforces architectural import boundaries between top-level modules.
 *
 * Rules:
 *   backend/  must not import from  cli/  or  websocket/
 *   providers/ must not import from  agent/  or  cli/
 *
 * These are currently violation-free. Adding a rule here means you must
 * also ensure no existing code violates it.
 *
 * To add a new rule, append an entry to RULES below.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { glob } from "glob";

const rootDir = process.cwd();
const srcDir = join(rootDir, "src");

/**
 * Each rule: files under `layer` must not contain an import from any of `forbidden`.
 * `description` is shown on violation.
 */
const RULES = [
  {
    layer: "backend",
    forbidden: ["cli", "websocket"],
    description:
      "backend/ is a low-level abstraction — it must not import from cli/ or websocket/",
  },
  {
    layer: "providers",
    forbidden: ["agent", "cli"],
    description:
      "providers/ are pure LLM adapters — they must not import from agent/ or cli/",
  },
];

// Matches: import ... from "@/forbidden/..." (static and dynamic)
function buildPattern(forbidden) {
  return new RegExp(
    `from\\s+["'\`]@/(${forbidden.join("|")})/`,
    "g",
  );
}

let violations = 0;

for (const rule of RULES) {
  const files = await glob(`src/${rule.layer}/**/*.{ts,tsx}`, {
    cwd: rootDir,
    ignore: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts"],
  });

  const pattern = buildPattern(rule.forbidden);

  for (const file of files.sort()) {
    const content = readFileSync(join(rootDir, file), "utf-8");
    const lines = content.split("\n");

    lines.forEach((line, i) => {
      // Reset lastIndex for global regex reuse
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        if (violations === 0) {
          console.error("\n❌ Layer boundary violations found:\n");
        }
        console.error(`  ${file}:${i + 1}`);
        console.error(`    ${line.trim()}`);
        console.error(`    ↳ ${rule.description}\n`);
        violations++;
      }
    });
  }
}

if (violations > 0) {
  console.error(
    `Found ${violations} boundary violation${violations === 1 ? "" : "s"}.`,
  );
  console.error(
    "Fix by moving the helper to a shared layer (utils/, types/) or inverting the dependency.\n",
  );
  process.exit(1);
} else {
  console.log("✅ No layer boundary violations found.");
}
