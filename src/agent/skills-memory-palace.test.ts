import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClientSkillsPayload } from "@/agent/client-skills";
import { isSkillAvailableForAgent, type Skill } from "@/agent/skills";
import { settingsManager } from "@/settings-manager";
import { readSkillContent } from "@/tools/impl/skill";

const SKILL_ID = "curating-memory-palace";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPalaceFlag = process.env.LETTA_MEMORY_PALACE;

let testHomeDir = "";

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-palace-skill-home-"));
  process.env.HOME = testHomeDir;
  process.env.USERPROFILE = testHomeDir;
  delete process.env.LETTA_MEMORY_PALACE;
  await settingsManager.initialize();
});

afterEach(async () => {
  await settingsManager.reset();
  if (testHomeDir) {
    await rm(testHomeDir, { recursive: true, force: true });
    testHomeDir = "";
  }

  process.env.HOME = originalHome;
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }

  if (originalPalaceFlag === undefined) {
    delete process.env.LETTA_MEMORY_PALACE;
  } else {
    process.env.LETTA_MEMORY_PALACE = originalPalaceFlag;
  }
});

async function palaceSkillOffer(agentId: string) {
  const payload = await buildClientSkillsPayload({
    agentId,
    skillSources: ["bundled"],
    attachedRepositories: [],
  });
  return {
    listed: payload.availableSkills.some((skill) => skill.name === SKILL_ID),
    content: readSkillContent(SKILL_ID, "/tmp/no-project-skills", agentId, {
      attachedRepositories: [],
    }),
  };
}

describe("curating-memory-palace skill", () => {
  test("is hidden while the memory_palace experiment is off", async () => {
    const offer = await palaceSkillOffer("agent-123");

    expect(offer.listed).toBe(false);
    await expect(offer.content).rejects.toThrow("not found");
  });

  test("is listed and readable for cloud and local agents when it is on", async () => {
    process.env.LETTA_MEMORY_PALACE = "1";

    for (const agentId of ["agent-123", "agent-local-123"]) {
      const offer = await palaceSkillOffer(agentId);

      expect(offer.listed).toBe(true);
      const { content } = await offer.content;
      expect(content).toContain("palace/MEMORY.md");
      expect(content).toContain("palace-action");
    }
  });

  test("keeps a project skill with the same name when the experiment is off", () => {
    const skill: Skill = {
      id: SKILL_ID,
      name: SKILL_ID,
      description: "Project copy",
      path: "/tmp/project/SKILL.md",
      source: "project",
    };

    expect(isSkillAvailableForAgent(skill, "agent-123")).toBe(true);
  });
});
