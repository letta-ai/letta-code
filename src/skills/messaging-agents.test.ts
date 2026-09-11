import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_FLAG_CATALOG } from "@/cli/args";

const skill = readFileSync(
  join(
    process.cwd(),
    "src",
    "skills",
    "builtin",
    "messaging-agents",
    "SKILL.md",
  ),
  "utf8",
);

// Headless flags the skill documents for `letta -p` messaging. Subcommand
// flags (agents/messages/computers) are parsed by their own subcommand
// parsers and are not part of the main CLI flag catalog.
const HEADLESS_FLAGS_DOCUMENTED = [
  "from-agent",
  "agent",
  "conversation",
  "computer",
  "output-format",
] as const;

describe("messaging-agents skill", () => {
  test("documents headless flags the CLI parser accepts", () => {
    for (const flag of HEADLESS_FLAGS_DOCUMENTED) {
      expect(flag in CLI_FLAG_CATALOG).toBe(true);
      expect(skill).toContain(`--${flag}`);
    }
  });

  test("uses the real headless JSON output flag", () => {
    expect(skill).toContain("--output-format json");
    expect(skill).not.toContain("--output json");
  });
});
