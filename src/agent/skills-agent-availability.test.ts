import { describe, expect, test } from "bun:test";
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
    for (const id of ["image-generation", "managing-context-repositories"]) {
      const skill: Skill = { ...baseSkill, id };
      expect(isSkillAvailableForAgent(skill, "agent-local-123")).toBe(false);
      expect(isSkillAvailableForAgent(skill, "agent-123")).toBe(true);
      expect(isSkillAvailableForAgent(skill, undefined)).toBe(true);
    }
  });

  test("keeps non-bundled overrides of cloud-only skills for local agents", () => {
    const skill: Skill = {
      ...baseSkill,
      id: "managing-context-repositories",
      source: "project",
    };
    expect(isSkillAvailableForAgent(skill, "agent-local-123")).toBe(true);
  });

  test("keeps other bundled skills for local agents", () => {
    const skill: Skill = { ...baseSkill, id: "scheduling-tasks" };
    expect(isSkillAvailableForAgent(skill, "agent-local-123")).toBe(true);
  });
});
