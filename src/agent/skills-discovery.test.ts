import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { discoverSkills, getBundledSkills } from "@/agent/skills";

test("scopes the memory filesystem skill to repository operations", async () => {
  const skills = await getBundledSkills();
  const skill = skills.find(
    (candidate) => candidate.id === "syncing-memory-filesystem",
  );

  expect(skill?.description).toContain(
    "Diagnose and repair MemFS repository setup, remote sync, authentication failures, optional backup remotes, or merge/rebase conflicts.",
  );
  expect(skill?.description).toContain(
    "Do not load for routine memory reads or edits.",
  );
});

test("bundles a portable browser-use fallback", async () => {
  const skills = await getBundledSkills();
  const skill = skills.find((candidate) => candidate.id === "browser-use");
  if (!skill) {
    throw new Error("browser-use bundled skill was not found");
  }

  const content = readFileSync(skill.path, "utf8");

  expect(skill.description).toContain("Control a rendered web browser");
  expect(content).toContain("### Chromium family");
  expect(content).toContain("### Firefox");
  expect(content).toContain("### Safari and WebKit");
  expect(content).toContain("environment-specific skills with this same name");
  expect(content).not.toContain("/root/.letta/cloud-skills");
  expect(content).not.toContain("start-letta-desktop");
});

test("keeps memory repository repair guidance aligned with the harness", async () => {
  const skills = await getBundledSkills();
  const skill = skills.find(
    (candidate) => candidate.id === "syncing-memory-filesystem",
  );
  if (!skill) {
    throw new Error("syncing-memory-filesystem bundled skill was not found");
  }

  const content = readFileSync(skill.path, "utf8");

  expect(content).toContain("`$MEMORY_DIR` is the repository root");
  expect(content).toContain("Do not run `git push` for normal MemFS sync");
  expect(content).toMatch(/the harness pushes\s+clean committed changes/);
  expect(content).toContain(
    "Do not reproduce `/memfs enable` by PATCHing agent tags",
  );
  expect(content).toMatch(/Do not change global Git\s+configuration\./);
  expect(content).toContain("GIT_EDITOR=true git -C");
  expect(content).toContain("rebase --continue");
  expect(content).toContain("/memory-repository push");

  expect(content).not.toContain("$LETTA_BASE_URL");
  expect(content).not.toContain("git config --global");
  expect(content).not.toContain("memory/system");
  expect(content).not.toContain("2-3s");
  expect(content).not.toContain('echo "Updated info" >');
  expect(content).not.toContain(
    '"tags": ["origin:letta-code", "git-memory-enabled"]',
  );
});

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
      writeSkill(externalSkillDir, "linked-skill");

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
      writeSkill(join(projectSkillsDir, "good-skill"), "good-skill");

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
      writeSkill(join(projectSkillsDir, "healthy-skill"), "healthy-skill");

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
      writeSkill(join(projectSkillsDir, "z-skill"), "z-skill");
      writeSkill(join(projectSkillsDir, "a-skill"), "a-skill");
      writeSkill(join(projectSkillsDir, "m-skill"), "m-skill");

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

describe("nested skill discovery", () => {
  const testDir = join(process.cwd(), ".test-nested-skill-resources");
  const projectSkillsDir = join(testDir, ".skills");

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("uses frontmatter names for nested skills", async () => {
    const skillDir = join(projectSkillsDir, "computer-use");
    const nestedResourceDir = join(skillDir, "references", "cua-driver");
    mkdirSync(nestedResourceDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: computer-use\ndescription: Control GUI applications\n---\n",
    );
    writeFileSync(
      join(nestedResourceDir, "SKILL.md"),
      "---\nname: cua-driver\ndescription: Cua Driver reference\n---\n",
    );

    const result = await discoverSkills(projectSkillsDir, undefined, {
      skipBundled: true,
      sources: ["project"],
    });

    expect(result.errors).toEqual([]);
    expect(result.skills.map((skill) => skill.id)).toEqual([
      "computer-use",
      "cua-driver",
    ]);
  });

  test("discovers skills inside category directories", async () => {
    const skillDir = join(projectSkillsDir, "creative", "image-generation");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: image-generation\ndescription: Generate images\n---\n",
    );

    const result = await discoverSkills(projectSkillsDir, undefined, {
      skipBundled: true,
      sources: ["project"],
    });

    expect(result.errors).toEqual([]);
    expect(result.skills.map((skill) => skill.id)).toEqual([
      "image-generation",
    ]);
  });
});

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
        "name: deploy",
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
