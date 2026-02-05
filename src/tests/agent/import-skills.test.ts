import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { extractSkillsFromAf } from "../../agent/import";

describe("skills extraction from .af files", () => {
  const testDir = join(process.cwd(), ".test-skills-import");
  const skillsDir = join(testDir, ".skills");
  const afPath = join(testDir, "test-agent.af");
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

  test("extracts single skill with multiple files", async () => {
    const afContent = {
      agents: [],
      blocks: [],
      sources: [],
      tools: [],
      mcp_servers: [],
      skills: [
        {
          name: "test-skill",
          files: {
            "SKILL.md":
              "---\nname: test-skill\ndescription: A test skill\n---\n\n# Test Skill\n\nThis is a test.",
            "scripts/hello": "#!/bin/bash\necho 'Hello from test skill'",
            "config.yaml": "version: 1.0\nfeatures:\n  - testing",
          },
        },
      ],
    };

    writeFileSync(afPath, JSON.stringify(afContent, null, 2));

    const extracted = await extractSkillsFromAf(afPath, skillsDir);

    expect(extracted).toEqual(["test-skill"]);
    expect(existsSync(join(skillsDir, "test-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillsDir, "test-skill", "scripts", "hello"))).toBe(
      true,
    );
    expect(existsSync(join(skillsDir, "test-skill", "config.yaml"))).toBe(true);

    const skillContent = await readFile(
      join(skillsDir, "test-skill", "SKILL.md"),
      "utf-8",
    );
    expect(skillContent).toContain("Test Skill");

    // Check executable permissions (skip on Windows - chmod not supported)
    if (process.platform !== "win32") {
      const scriptStats = await stat(
        join(skillsDir, "test-skill", "scripts", "hello"),
      );
      expect(scriptStats.mode & 0o111).not.toBe(0);
    }
  });

  test("extracts skill with source_url metadata", async () => {
    const afContent = {
      agents: [],
      blocks: [],
      sources: [],
      tools: [],
      mcp_servers: [],
      skills: [
        {
          name: "slack",
          files: {
            "SKILL.md":
              "---\nname: slack\ndescription: Slack integration\n---\n\n# Slack Skill",
            "scripts/slack": "#!/bin/bash\necho 'Slack CLI'",
          },
          source_url: "letta-ai/skills/tools/slack",
        },
      ],
    };

    writeFileSync(afPath, JSON.stringify(afContent, null, 2));

    const extracted = await extractSkillsFromAf(afPath, skillsDir);

    expect(extracted).toEqual(["slack"]);
    expect(existsSync(join(skillsDir, "slack", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillsDir, "slack", "scripts", "slack"))).toBe(true);
  });

  test("overwrites existing skills", async () => {
    mkdirSync(join(skillsDir, "existing-skill"), { recursive: true });
    writeFileSync(
      join(skillsDir, "existing-skill", "SKILL.md"),
      "# Old Version\n\nThis will be overwritten.",
    );

    const afContent = {
      agents: [],
      blocks: [],
      sources: [],
      tools: [],
      mcp_servers: [],
      skills: [
        {
          name: "existing-skill",
          files: {
            "SKILL.md": "# New Version\n\nThis is the updated version.",
          },
        },
      ],
    };

    writeFileSync(afPath, JSON.stringify(afContent, null, 2));

    const extracted = await extractSkillsFromAf(afPath, skillsDir);

    expect(extracted).toEqual(["existing-skill"]);

    const newContent = await readFile(
      join(skillsDir, "existing-skill", "SKILL.md"),
      "utf-8",
    );
    expect(newContent).toContain("New Version");
    expect(newContent).not.toContain("Old Version");
  });

  test("handles multiple skills", async () => {
    const afContent = {
      agents: [],
      blocks: [],
      sources: [],
      tools: [],
      mcp_servers: [],
      skills: [
        {
          name: "skill-one",
          files: {
            "SKILL.md": "# Skill One",
          },
        },
        {
          name: "skill-two",
          files: {
            "SKILL.md": "# Skill Two",
          },
        },
        {
          name: "skill-three",
          files: {
            "SKILL.md": "# Skill Three",
          },
        },
      ],
    };

    writeFileSync(afPath, JSON.stringify(afContent, null, 2));

    const extracted = await extractSkillsFromAf(afPath, skillsDir);

    expect(extracted).toEqual(["skill-one", "skill-two", "skill-three"]);
    expect(existsSync(join(skillsDir, "skill-one", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillsDir, "skill-two", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillsDir, "skill-three", "SKILL.md"))).toBe(true);
  });

  test("handles .af without skills", async () => {
    const afContent = {
      agents: [],
      blocks: [],
      sources: [],
      tools: [],
      mcp_servers: [],
      skills: [],
    };

    writeFileSync(afPath, JSON.stringify(afContent, null, 2));

    const extracted = await extractSkillsFromAf(afPath, skillsDir);

    expect(extracted).toEqual([]);
  });

  test.skipIf(process.env.CI === "true")(
    "fetches skill from remote source_url (integration)",
    async () => {
      const afContent = {
        agents: [],
        blocks: [],
        sources: [],
        tools: [],
        mcp_servers: [],
        skills: [
          {
            name: "imessage",
            source_url: "letta-ai/skills/main/tools/imessage",
          },
        ],
      };

      writeFileSync(afPath, JSON.stringify(afContent, null, 2));

      const extracted = await extractSkillsFromAf(afPath, skillsDir);

      expect(extracted).toEqual(["imessage"]);
      expect(existsSync(join(skillsDir, "imessage", "SKILL.md"))).toBe(true);
    },
  );
});
