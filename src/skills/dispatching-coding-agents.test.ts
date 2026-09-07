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
  test("advertises dated Claude Code and Codex model catalogs", () => {
    expect(frontmatter).toContain("Model catalog checked 2026-08-25");
    expect(frontmatter).toContain("Sonnet 5, Opus 5, and Fable 5");
    expect(frontmatter).toContain("GPT-5.6 Luna, Terra, and Sol");
    expect(skill).toContain("Codex (catalog checked 2026-08-25)");
    expect(skill).toContain("`gpt-5.6-luna`");
    expect(skill).toContain("`gpt-5.6-terra`");
    expect(skill).toContain("`gpt-5.6-sol`");
    expect(skill).toContain("`best`: highest-capability model");
    expect(skill).toContain("`fable`: Fable 5");
    expect(skill).toContain("--model fable");
  });

  test("uses configured defaults unless a model is requested", () => {
    expect(skill).toContain("configured default model");
    expect(skill).toContain('codex exec "YOUR PROMPT" -m gpt-5.6-sol');
  });

  test("avoids deprecated Codex flags and nonexistent Bash options", () => {
    expect(skill).toContain(
      'codex exec "YOUR PROMPT" --sandbox workspace-write',
    );
    expect(skill).not.toContain("--full-auto");
    expect(skill).not.toMatch(/Bash tool.{0,40}`workdir`/i);
  });

  test("lists current Claude Code effort levels", () => {
    expect(skill).toContain("`xhigh`");
    expect(skill).toContain("`max`");
  });

  test("uses correct JSON output field name", () => {
    expect(skill).toContain("`total_cost_usd`");
    expect(skill).not.toContain("`cost_usd`");
  });

  test("distinguishes --allowedTools from --tools", () => {
    expect(skill).toContain("--tools");
    expect(skill).toContain("without prompting for permission");
  });

  test("does not list --search as a codex exec flag", () => {
    const codexSection = skill.slice(
      skill.indexOf("### Codex"),
      skill.indexOf("## Session Management"),
    );
    expect(codexSection).not.toContain("--search");
  });
});
