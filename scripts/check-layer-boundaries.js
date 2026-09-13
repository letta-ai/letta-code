#!/usr/bin/env node
/**
 * Enforces architectural import boundaries between top-level modules.
 *
 * Rules:
 *   tools/              must not import from  cli/
 *   backend/            must not import from  cli/  or  websocket/
 *   providers/          must not import from  agent/  or  cli/
 *   websocket/listener/ must not import from  backend/api/client  or  backend/api/conversations
 *   telemetry/          must not import from  cli/  agent/  websocket/  or  tools/
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
    layer: "tools",
    forbidden: ["cli"],
    description:
      "tools/ run in headless and agent contexts — they must not import from cli/",
  },
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
  {
    layer: "websocket/listener",
    forbidden: ["backend/api/client", "backend/api/conversations"],
    description:
      "websocket/listener/ uses the getBackend() abstraction — it must not import the raw API client or conversations module directly",
  },
  {
    layer: "cli/app",
    forbidden: ["backend/api/conversations"],
    description:
      "cli/app/ uses the getBackend() abstraction for conversation operations — it must not import the raw conversations module directly",
  },
  {
    layer: "telemetry",
    forbidden: ["cli", "agent", "websocket", "tools"],
    description:
      "telemetry/ is a leaf observer — it must not import from cli/, agent/, websocket/, or tools/ (only backend/api/ for submitting data is permitted)",
  },
  {
    layer: "sandbox",
    forbidden: [
      "cli",
      "agent",
      "tools",
      "websocket",
      "backend",
      "providers",
      "permissions",
      "channels",
      "cron",
      "telemetry",
    ],
    description:
      "sandbox/ is a pure leaf — it generates sandbox argv/profiles from plain paths. It must not import from any domain layer; callers resolve paths and pass them in",
  },
];

// Matches: import ... from "@/forbidden/..." (static imports only)
function buildPattern(forbidden) {
  return new RegExp(`from\\s+["'\`]@/(${forbidden.join("|")})/`, "g");
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
