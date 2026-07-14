import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { discoverSkills } from "@/agent/skills";

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

    test("returns discovered skills in deterministic sorted order", async () => {
      mkdirSync(projectSkillsDir, { recursive: true });
      writeSkill(join(projectSkillsDir, "z-skill"), "Z Skill");
      writeSkill(join(projectSkillsDir, "a-skill"), "A Skill");
      writeSkill(join(projectSkillsDir, "m-skill"), "M Skill");

      const result = await discoverSkills(projectSkillsDir, undefined, {
        skipBundled: true,
        sources: ["project"],
      });

      expect(result.errors).toHaveLength(0);
      expect(result.skills.map((skill) => skill.id)).toEqual([
        "a-skill",
        "m-skill",
        "z-skill",
      ]);
    });
  },
);

describe("agent skills discovery", () => {
  const testDir = join(process.cwd(), ".test-agent-skills-discovery");
  const projectSkillsDir = join(testDir, ".skills");
  const originalHome = process.env.HOME;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    process.env.HOME = testDir;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("does not discover legacy pre-memfs agent skills", async () => {
    mkdirSync(projectSkillsDir, { recursive: true });
    const skillDir = join(
      testDir,
      ".letta",
      "agents",
      "agent-test",
      "skills",
      "legacy-only",
    );
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: Legacy Only\ndescription: legacy skill\n---\n\n# Legacy Only\n",
    );

    const result = await discoverSkills(projectSkillsDir, "agent-test", {
      skipBundled: true,
      sources: ["agent"],
    });

    expect(result.errors).toHaveLength(0);
    expect(result.skills).toHaveLength(0);
  });
});

describe("skills frontmatter metadata", () => {
  const testDir = join(process.cwd(), ".test-skills-frontmatter");
  const projectSkillsDir = join(testDir, ".skills");
  const originalCwd = process.cwd();

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

  test("parses invocation controls, ignores legacy arguments frontmatter, and appends when_to_use to description", async () => {
    const skillDir = join(projectSkillsDir, "deploy");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: Deploy",
        "description: Deploy the application",
        "when_to_use: When the user asks to ship a release",
        "argument-hint: [environment]",
        "arguments: environment version",
        "disable-model-invocation: true",
        "user-invocable: false",
        "---",
        "",
        "Deploy $environment at $version.",
      ].join("\n"),
    );

    const result = await discoverSkills(projectSkillsDir, undefined, {
      skipBundled: true,
      sources: ["project"],
    });

    expect(result.errors).toHaveLength(0);
    expect(result.skills).toHaveLength(1);
    const skill = result.skills[0];
    expect(skill?.id).toBe("deploy");
    expect(skill?.description).toContain("Deploy the application");
    expect(skill?.description).toContain(
      "When to use: When the user asks to ship a release",
    );
    expect(skill?.argumentHint).toBe("[environment]");
    expect(skill).not.toHaveProperty("arguments");
    expect(skill?.disableModelInvocation).toBe(true);
    expect(skill?.userInvocable).toBe(false);
  });
});
