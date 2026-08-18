import { describe, expect, test } from "bun:test";
import { GIT_MEMORY_ENABLED_TAG, MEMFS_V2_TAG } from "@/agent/agent-tags";
import { isSkillAvailableForAgent, type Skill } from "@/agent/skills";

const baseSkill: Skill = {
  id: "base",
  name: "Base",
  description: "Base skill",
  path: "/tmp/base/SKILL.md",
  source: "bundled",
};

describe("isSkillAvailableForAgent", () => {
  test("excludes bundled cloud-only skills for local agents", async () => {
    for (const id of ["image-generation", "managing-shared-memory"]) {
      const skill: Skill = { ...baseSkill, id };
      expect(isSkillAvailableForAgent(skill, "agent-local-123")).toBe(false);
      expect(isSkillAvailableForAgent(skill, "agent-123")).toBe(true);
      expect(isSkillAvailableForAgent(skill, undefined)).toBe(true);
    }
  });

  test("keeps non-bundled overrides of cloud-only skills for local agents", () => {
    const skill: Skill = {
      ...baseSkill,
      id: "managing-shared-memory",
      source: "project",
    };
    expect(isSkillAvailableForAgent(skill, "agent-local-123")).toBe(true);
  });

  test("keeps other bundled skills for local agents", () => {
    const skill: Skill = { ...baseSkill, id: "scheduling-tasks" };
    expect(isSkillAvailableForAgent(skill, "agent-local-123")).toBe(true);
  });

  test("shows the v2 migration only to v1 local agents", () => {
    const skill: Skill = {
      ...baseSkill,
      id: "upgrading-memory-filesystem",
    };

    expect(
      isSkillAvailableForAgent(skill, "agent-local-123", [
        GIT_MEMORY_ENABLED_TAG,
      ]),
    ).toBe(true);
    expect(
      isSkillAvailableForAgent(skill, "agent-local-123", [
        GIT_MEMORY_ENABLED_TAG,
        MEMFS_V2_TAG,
      ]),
    ).toBe(false);
    expect(isSkillAvailableForAgent(skill, "agent-123")).toBe(false);
  });

  test("keeps non-bundled migration overrides available", () => {
    const skill: Skill = {
      ...baseSkill,
      id: "upgrading-memory-filesystem",
      source: "project",
    };

    expect(
      isSkillAvailableForAgent(skill, "agent-local-123", [MEMFS_V2_TAG]),
    ).toBe(true);
  });
});
