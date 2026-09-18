import { describe, expect, test } from "bun:test";
import { buildClientSkillsPayload } from "@/agent/client-skills";
import { isSkillAvailableForAgent, type Skill } from "@/agent/skills";
import { clearTraySupportCacheForTests } from "@/backend/api/tray-support";
import { settingsManager } from "@/settings-manager";
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
      "managing-tray",
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

  test("hides bundled managing-tray when Tray is unavailable", () => {
    const skill: Skill = { ...baseSkill, id: "managing-tray" };
    expect(isSkillAvailableForAgent(skill, "agent-123", false)).toBe(false);
    expect(isSkillAvailableForAgent(skill, "agent-123", true)).toBe(true);
  });

  test("hides bundled managing-tray for an anonymous agent when Tray is unavailable", () => {
    const skill: Skill = { ...baseSkill, id: "managing-tray" };
    expect(isSkillAvailableForAgent(skill, undefined, false)).toBe(false);
    expect(isSkillAvailableForAgent(skill, undefined, true)).toBe(true);
  });

  test("keeps non-bundled managing-tray overrides regardless of Tray availability", () => {
    const skill: Skill = {
      ...baseSkill,
      id: "managing-tray",
      source: "project",
    };
    expect(isSkillAvailableForAgent(skill, "agent-123", false)).toBe(true);
    expect(isSkillAvailableForAgent(skill, "agent-local-123", false)).toBe(
      true,
    );
  });
});

async function withTrayServer(
  status: 200 | 404,
  run: (requests: string[]) => Promise<void>,
): Promise<void> {
  const previousBaseUrl = process.env.LETTA_BASE_URL;
  const previousApiKey = process.env.LETTA_API_KEY;
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(new URL(request.url).pathname);
      return Response.json(
        status === 200 ? { items: [] } : { error: "missing" },
        {
          status,
        },
      );
    },
  });
  process.env.LETTA_BASE_URL = `http://127.0.0.1:${server.port}`;
  process.env.LETTA_API_KEY = "tray-support-test";
  clearTraySupportCacheForTests();
  try {
    await settingsManager.initialize();
    await run(requests);
  } finally {
    server.stop(true);
    clearTraySupportCacheForTests();
    if (previousBaseUrl === undefined) delete process.env.LETTA_BASE_URL;
    else process.env.LETTA_BASE_URL = previousBaseUrl;
    if (previousApiKey === undefined) delete process.env.LETTA_API_KEY;
    else process.env.LETTA_API_KEY = previousApiKey;
  }
}

describe("Tray skill availability through localhost API servers", () => {
  test("discovers and directly loads managing-tray through a Cloud proxy", async () => {
    await withTrayServer(200, async (requests) => {
      const agentId = "agent-tray-proxy";
      const payload = await buildClientSkillsPayload({
        agentId,
        skillSources: ["bundled"],
        attachedRepositories: [],
      });
      expect(
        payload.availableSkills.some((skill) => skill.name === "managing-tray"),
      ).toBe(true);

      const loaded = await readSkillContent(
        "managing-tray",
        "/tmp/no-project-skills",
        agentId,
        { attachedRepositories: [] },
      );
      expect(loaded.content).toContain("# Managing Tray");
      expect(requests).toEqual([
        `/v1/agents/${agentId}/conversations/default/tray`,
      ]);
    });
  });

  test("hides and rejects managing-tray on a self-hosted server", async () => {
    await withTrayServer(404, async (requests) => {
      const agentId = "agent-tray-self-hosted";
      const payload = await buildClientSkillsPayload({
        agentId,
        skillSources: ["bundled"],
        attachedRepositories: [],
      });
      expect(
        payload.availableSkills.some((skill) => skill.name === "managing-tray"),
      ).toBe(false);

      await expect(
        readSkillContent("managing-tray", "/tmp/no-project-skills", agentId, {
          attachedRepositories: [],
        }),
      ).rejects.toThrow('Skill "managing-tray" not found');
      expect(requests).toEqual([
        `/v1/agents/${agentId}/conversations/default/tray`,
      ]);
    });
  });
});
