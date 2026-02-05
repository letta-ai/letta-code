import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packageSkills } from "../../agent/export";

describe("packageSkills from .skills/ directory", () => {
  const testDir = join(process.cwd(), ".test-skills-export");
  const skillsDir = join(testDir, ".skills");
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

  test("packages single skill", async () => {
    mkdirSync(join(skillsDir, "test-skill"), { recursive: true });
    writeFileSync(
      join(skillsDir, "test-skill", "SKILL.md"),
      "---\nname: test-skill\ndescription: Test\n---\n\n# Test Skill",
    );
    writeFileSync(join(skillsDir, "test-skill", "config.yaml"), "version: 1.0");

    const skills = await packageSkills(undefined, skillsDir);

    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("test-skill");
    expect(skills[0]?.files?.["SKILL.md"]).toContain("Test Skill");
    expect(skills[0]?.files?.["config.yaml"]).toBe("version: 1.0");
  });

  test("packages multiple skills", async () => {
    for (const name of ["skill-one", "skill-two"]) {
      mkdirSync(join(skillsDir, name), { recursive: true });
      writeFileSync(join(skillsDir, name, "SKILL.md"), `# ${name}`);
    }

    const skills = await packageSkills(undefined, skillsDir);

    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.name).sort()).toEqual([
      "skill-one",
      "skill-two",
    ]);
  });

  test("includes nested files", async () => {
    mkdirSync(join(skillsDir, "nested-skill", "scripts"), { recursive: true });
    writeFileSync(join(skillsDir, "nested-skill", "SKILL.md"), "# Nested");
    writeFileSync(
      join(skillsDir, "nested-skill", "scripts", "run.sh"),
      "#!/bin/bash\necho hello",
    );

    const skills = await packageSkills(undefined, skillsDir);

    expect(skills).toHaveLength(1);
    expect(skills[0]?.files?.["SKILL.md"]).toBeDefined();
    expect(skills[0]?.files?.["scripts/run.sh"]).toBeDefined();
  });

  test("skips skills without SKILL.md", async () => {
    mkdirSync(join(skillsDir, "invalid-skill"), { recursive: true });
    writeFileSync(join(skillsDir, "invalid-skill", "README.md"), "No SKILL.md");

    const skills = await packageSkills(undefined, skillsDir);

    expect(skills).toHaveLength(0);
  });

  test("returns empty array when .skills/ missing", async () => {
    const skills = await packageSkills(undefined, skillsDir);
    expect(skills).toEqual([]);
  });
});
