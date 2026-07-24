import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const skill = readFileSync(
  join(
    process.cwd(),
    "src",
    "skills",
    "builtin",
    "dispatching-coding-agents",
    "SKILL.md",
  ),
  "utf8",
);

describe("dispatching-coding-agents skill", () => {
  test("uses configured defaults instead of versioned model guidance", () => {
    expect(skill).toContain("configured default model");
    expect(skill).not.toMatch(/\bgpt-\d/i);
    expect(skill).not.toMatch(/\bclaude-[a-z][a-z0-9-]*-\d/i);
  });

  test("avoids deprecated Codex flags and nonexistent Bash options", () => {
    expect(skill).toContain(
      'codex exec "YOUR PROMPT" --sandbox workspace-write',
    );
    expect(skill).not.toContain("--full-auto");
    expect(skill).not.toMatch(/Bash tool.{0,40}`workdir`/i);
  });
});
