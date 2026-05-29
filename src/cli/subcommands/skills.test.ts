import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installSkillDirectory,
  parseClawHubSpecifier,
  parseGitHubSpecifier,
} from "./skills";

describe("skills subcommand", () => {
  test("parses GitHub tree URLs", () => {
    expect(
      parseGitHubSpecifier(
        "https://github.com/owner/repo/tree/main/path/to/skill",
      ),
    ).toEqual({
      repoUrl: "https://github.com/owner/repo.git",
      branch: null,
      subdir: "main/path/to/skill",
    });
  });

  test("parses GitHub blob SKILL.md URLs as their containing skill directory", () => {
    expect(
      parseGitHubSpecifier(
        "https://github.com/owner/repo/blob/main/path/to/skill/SKILL.md",
      ),
    ).toEqual({
      repoUrl: "https://github.com/owner/repo.git",
      branch: null,
      subdir: "main/path/to/skill",
    });
  });

  test("parses ClawHub specifiers", () => {
    expect(parseClawHubSpecifier("clawhub/nano-banana-pro")).toEqual({
      slug: "nano-banana-pro",
      version: null,
    });
    expect(parseClawHubSpecifier("clawhub:nano-banana-pro@1.0.1")).toEqual({
      slug: "nano-banana-pro",
      version: "1.0.1",
    });
    expect(
      parseClawHubSpecifier("https://clawhub.ai/skills/nano-banana-pro"),
    ).toEqual({
      slug: "nano-banana-pro",
      version: null,
    });
  });

  test("installs a skill directory into memfs skills using frontmatter name", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "letta-skills-test-"));
    try {
      const sourceDir = join(tempRoot, "source", "finance", "stocks");
      const memoryDir = join(tempRoot, "memory");
      await mkdir(join(sourceDir, "scripts"), { recursive: true });
      writeFileSync(
        join(sourceDir, "SKILL.md"),
        "---\nname: market-data\ndescription: test\n---\n\n# Market Data\n",
      );
      writeFileSync(join(sourceDir, "scripts", "client.py"), "print('ok')\n");

      const result = await installSkillDirectory({ sourceDir, memoryDir });

      expect(result.name).toBe("market-data");
      expect(await readFile(join(result.path, "SKILL.md"), "utf8")).toContain(
        "# Market Data",
      );
      expect(
        await readFile(join(result.path, "scripts", "client.py"), "utf8"),
      ).toBe("print('ok')\n");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
