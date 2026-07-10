import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  repairMissingSkillNameFrontmatter,
  repairSkillNameFrontmatterContent,
} from "@/cli/helpers/skill-name-frontmatter-repair";

let fixtureRoot: string | null = null;

function createFixtureRoot(prefix: string): string {
  fixtureRoot = mkdtempSync(join(tmpdir(), prefix));
  return fixtureRoot;
}

afterEach(() => {
  if (fixtureRoot && existsSync(fixtureRoot)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
  fixtureRoot = null;
});

test("repairSkillNameFrontmatterContent inserts missing name header", () => {
  const repaired = repairSkillNameFrontmatterContent(
    "---\ndescription: Updates docs\n---\n\n# Updating docs\n",
    "updating-docs",
  );

  expect(repaired.changed).toBe(true);
  expect(repaired.content).toBe(
    "---\nname: updating-docs\ndescription: Updates docs\n---\n\n# Updating docs\n",
  );
});

test("repairSkillNameFrontmatterContent leaves existing names unchanged", () => {
  const original = "---\nname: updating-docs\ndescription: Updates docs\n---\n";
  const repaired = repairSkillNameFrontmatterContent(original, "updating-docs");

  expect(repaired.changed).toBe(false);
  expect(repaired.content).toBe(original);
});

test("repairMissingSkillNameFrontmatter repairs memory skills", async () => {
  const memoryDir = createFixtureRoot("skill-name-repair-");
  const skillDir = join(memoryDir, "skills", "updating-wiki");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\ndescription: Regenerates the wiki\n---\n\n# Updating Wiki\n",
  );

  const result = await repairMissingSkillNameFrontmatter(memoryDir);

  expect(result.scanned).toBe(1);
  expect(result.repaired).toEqual(["skills/updating-wiki/SKILL.md"]);
  expect(result.skipped).toEqual([]);
  await expect(readFile(join(skillDir, "SKILL.md"), "utf8")).resolves.toContain(
    "name: updating-wiki\ndescription:",
  );
});

test("repairMissingSkillNameFrontmatter reports malformed skills without rewriting", async () => {
  const memoryDir = createFixtureRoot("skill-name-repair-malformed-");
  const skillDir = join(memoryDir, "skills", "broken-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# Broken\n");

  const result = await repairMissingSkillNameFrontmatter(memoryDir);

  expect(result.scanned).toBe(1);
  expect(result.repaired).toEqual([]);
  expect(result.skipped).toEqual([
    {
      path: "skills/broken-skill/SKILL.md",
      reason: "missing YAML frontmatter",
    },
  ]);
});
