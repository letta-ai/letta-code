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
  test("uses runtime CLI discovery instead of versioned model guidance", () => {
    expect(skill).toContain("command -v claude && claude --version");
    expect(skill).toContain("command -v codex && codex --version");
    expect(skill).toContain("configured default model");
    expect(skill).not.toMatch(/\bgpt-\d/i);
    expect(skill).not.toMatch(/\bclaude-[a-z][a-z0-9-]*-\d/i);
    expect(skill).not.toContain("latest frontier");
  });

  test("documents durable working-directory and sandbox controls", () => {
    expect(skill).toContain(
      'cd "/absolute/path/to/repo" && claude -p "YOUR PROMPT" --output-format json',
    );
    expect(skill).toContain(
      'codex exec -C "/absolute/path/to/repo" --sandbox read-only --json "YOUR PROMPT"',
    );
    expect(skill).toContain(
      'codex exec -C "/absolute/path/to/repo" --sandbox workspace-write --json "YOUR PROMPT"',
    );
    expect(skill).not.toContain("--full-auto");
    expect(skill).not.toMatch(/Bash tool.{0,40}`workdir`/i);
  });

  test("requires successful turn completion and conditional permission bypass", () => {
    expect(skill).toContain(
      "Permission bypass is appropriate only when the process is already isolated",
    );
    expect(skill).toContain(
      "A launched process is not proof of a successful dispatch.",
    );
    expect(skill).toContain("completed an agent turn");
  });
});
