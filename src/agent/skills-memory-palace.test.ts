import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClientSkillsPayload } from "@/agent/client-skills";
import {
  discoverSkills,
  isSkillAvailableForAgent,
  type Skill,
} from "@/agent/skills";
import { experimentManager } from "@/experiments/manager";
import { settingsManager } from "@/settings-manager";
import { readSkillContent } from "@/tools/impl/skill";

const SKILL_ID = "curating-memory-palace";
const CLOUD_AGENT_ID = "agent-123";
const LOCAL_AGENT_ID = "agent-local-123";

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
  const discovery = await discoverSkills("/tmp/no-project-skills", agentId, {
    sources: ["bundled"],
  });
  return {
    listed: payload.availableSkills.some((skill) => skill.name === SKILL_ID),
    discovered: discovery.skills.some((skill) => skill.id === SKILL_ID),
    content: readSkillContent(SKILL_ID, "/tmp/no-project-skills", agentId, {
      attachedRepositories: [],
    }),
  };
}

describe("curating-memory-palace skill", () => {
  test("is listed and readable for Cloud agents with the memory_palace experiment off", async () => {
    expect(experimentManager.isEnabled("memory_palace")).toBe(false);

    const offer = await palaceSkillOffer(CLOUD_AGENT_ID);

    expect(offer.listed).toBe(true);
    expect(offer.discovered).toBe(true);
    const { content } = await offer.content;
    expect(content).toContain("palace/MEMORY.md");
    expect(content).toContain("palace-action");
  });

  test("is not offered to local agents", async () => {
    const offer = await palaceSkillOffer(LOCAL_AGENT_ID);

    expect(offer.listed).toBe(false);
    expect(offer.discovered).toBe(false);
    await expect(offer.content).rejects.toThrow("not found");
  });

  test("keeps a local agent's own copy of the skill", () => {
    const skill: Skill = {
      id: SKILL_ID,
      name: SKILL_ID,
      description: "Project copy",
      path: "/tmp/project/SKILL.md",
      source: "project",
    };

    expect(isSkillAvailableForAgent(skill, LOCAL_AGENT_ID)).toBe(true);
  });
});
