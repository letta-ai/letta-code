import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { discoverSkills } from "../../agent/skills";

describe.skipIf(process.platform === "win32")(
  "skills discovery with symlinks",
  () => {
    const testDir = join(process.cwd(), ".test-skills-discovery");
    const projectSkillsDir = join(testDir, ".skills");
    const originalCwd = process.cwd();

    const writeSkill = (skillDir: string, skillName: string) => {
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        `---\nname: ${skillName}\ndescription: ${skillName} description\n---\n\n# ${skillName}\n`,
      );
    };

    beforeEach(() => {
      mkdirSync(testDir, { recursive: true });
      process.chdir(testDir);
    });

    afterEach(() => {
      process.chdir(originalCwd);
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    test("discovers skills from symlinked directories", async () => {
      mkdirSync(projectSkillsDir, { recursive: true });

      const externalSkillDir = join(testDir, "external-skill");
      writeSkill(externalSkillDir, "Linked Skill");

      symlinkSync(
        externalSkillDir,
        join(projectSkillsDir, "linked-skill"),
        "dir",
      );

      const result = await discoverSkills(projectSkillsDir, undefined, {
        skipBundled: true,
        sources: ["project"],
      });

      expect(result.errors).toHaveLength(0);
      expect(result.skills.some((skill) => skill.id === "linked-skill")).toBe(
        true,
      );
    });

    test("handles symlink cycles without hanging and still discovers siblings", async () => {
      mkdirSync(projectSkillsDir, { recursive: true });
      writeSkill(join(projectSkillsDir, "good-skill"), "Good Skill");

      const cycleDir = join(projectSkillsDir, "cycle");
      mkdirSync(cycleDir, { recursive: true });
      symlinkSync("..", join(cycleDir, "loop"), "dir");

      const result = (await Promise.race([
        discoverSkills(projectSkillsDir, undefined, {
          skipBundled: true,
          sources: ["project"],
        }),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("skills discovery timed out")),
            2000,
          );
        }),
      ])) as Awaited<ReturnType<typeof discoverSkills>>;

      expect(result.skills.some((skill) => skill.id === "good-skill")).toBe(
        true,
      );
    });

    test("continues discovery when a dangling symlink cannot be inspected", async () => {
      mkdirSync(projectSkillsDir, { recursive: true });
      writeSkill(join(projectSkillsDir, "healthy-skill"), "Healthy Skill");

      symlinkSync(
        join(projectSkillsDir, "missing-target"),
        join(projectSkillsDir, "broken-link"),
        "dir",
      );

      const result = await discoverSkills(projectSkillsDir, undefined, {
        skipBundled: true,
        sources: ["project"],
      });

      expect(result.skills.some((skill) => skill.id === "healthy-skill")).toBe(
        true,
      );
      expect(
        result.errors.some((error) => error.path.includes("broken-link")),
      ).toBe(true);
    });
  },
);
