import { describe, expect, test } from "bun:test";
import { buildClientSkillsPayload } from "@/agent/client-skills";
import { isSkillAvailableForAgent, type Skill } from "@/agent/skills";
import { readSkillContent } from "@/tools/impl/skill";

const baseSkill: Skill = {
  id: "base",
  name: "Base",
  description: "Base skill",
  path: "/tmp/base/SKILL.md",
  source: "bundled",
};

describe("isSkillAvailableForAgent", () => {
  test("excludes bundled cloud-only skills for local agents", async () => {
    for (const id of [
      "image-generation",
      "managing-shared-memory",
      "working-across-computers",
    ]) {
      const skill: Skill = { ...baseSkill, id };
      expect(isSkillAvailableForAgent(skill, "agent-local-123")).toBe(false);
      expect(isSkillAvailableForAgent(skill, "agent-123")).toBe(true);
      expect(isSkillAvailableForAgent(skill, undefined)).toBe(true);
    }
  });

  test("exposes the real computer skill only to Cloud agents", async () => {
    const skillId = "working-across-computers";
    for (const [agentId, available] of [
      ["agent-local-123", false],
      ["agent-123", true],
    ] as const) {
      const payload = await buildClientSkillsPayload({
        agentId,
        skillSources: ["bundled"],
        attachedRepositories: [],
      });
      expect(payload.clientSkills.some((skill) => skill.name === skillId)).toBe(
        available,
      );
      expect(
        payload.availableSkills.some((skill) => skill.name === skillId),
      ).toBe(available);
      const content = readSkillContent(
        skillId,
        "/tmp/no-project-skills",
        agentId,
        {
          attachedRepositories: [],
        },
      );
      if (available) {
        expect((await content).content).toContain("letta teleport cloud");
      } else {
        await expect(content).rejects.toThrow("not found");
      }
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
    for (const id of [
      "scheduling-tasks",
      "submitting-feedback",
      "using-mcp-tools",
    ]) {
      const skill: Skill = { ...baseSkill, id };
      expect(isSkillAvailableForAgent(skill, "agent-local-123")).toBe(true);
    }
  });
});
