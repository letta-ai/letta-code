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
const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";

describe("dispatching-coding-agents skill", () => {
  test("advertises current Claude Code model aliases", () => {
    expect(frontmatter).toContain("Fable");
    expect(skill).toContain("`best`: highest-capability model");
    expect(skill).toContain("`fable`: hardest, long-running tasks");
    expect(skill).toContain("--model fable");
  });

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
