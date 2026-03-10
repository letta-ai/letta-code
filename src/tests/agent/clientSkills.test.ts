import { describe, expect, test } from "bun:test";
import type { Skill, SkillDiscoveryResult } from "../../agent/skills";

const baseSkill: Skill = {
  id: "base",
  name: "Base",
  description: "Base skill",
  path: "/tmp/base/SKILL.md",
  source: "project",
};

describe("buildClientSkillsPayload", () => {
  test("returns deterministically sorted client skills and path map", async () => {
    const { buildClientSkillsPayload } = await import(
      "../../agent/clientSkills"
    );

    const discoverSkillsFn = async (): Promise<SkillDiscoveryResult> => ({
      skills: [
        {
          ...baseSkill,
          id: "z-skill",
          description: "z",
          path: "/tmp/z/SKILL.md",
          source: "project",
        },
        {
          ...baseSkill,
          id: "a-skill",
          description: "a",
          path: "/tmp/a/SKILL.md",
          source: "bundled",
        },
      ],
      errors: [],
    });

    const result = await buildClientSkillsPayload({
      agentId: "agent-1",
      skillsDirectory: "/tmp/.skills",
      skillSources: ["project", "bundled"],
      discoverSkillsFn,
    });

    expect(result.clientSkills).toEqual([
      {
        name: "a-skill",
        description: "a",
        location: "/tmp/a/SKILL.md",
      },
      {
        name: "z-skill",
        description: "z",
        location: "/tmp/z/SKILL.md",
      },
    ]);
    expect(result.skillPathById).toEqual({
      "a-skill": "/tmp/a/SKILL.md",
      "z-skill": "/tmp/z/SKILL.md",
    });
    expect(result.errors).toEqual([]);
  });

  test("fails open with empty client_skills when discovery throws", async () => {
    const { buildClientSkillsPayload } = await import(
      "../../agent/clientSkills"
    );

    const discoverSkillsFn = async (): Promise<SkillDiscoveryResult> => {
      throw new Error("boom");
    };

    const logs: string[] = [];
    const result = await buildClientSkillsPayload({
      skillsDirectory: "/tmp/.skills",
      discoverSkillsFn,
      logger: (m) => logs.push(m),
    });

    expect(result.clientSkills).toEqual([]);
    expect(result.skillPathById).toEqual({});
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe("/tmp/.skills");
    expect(
      logs.some((m) => m.includes("Failed to build client_skills payload")),
    ).toBe(true);
  });
});
