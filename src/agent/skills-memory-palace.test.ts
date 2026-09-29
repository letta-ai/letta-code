import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClientSkillsPayload } from "@/agent/client-skills";
import { discoverSkills } from "@/agent/skills";
import { experimentManager } from "@/experiments/manager";
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

describe("curating-memory-palace skill", () => {
  test("is listed and readable for cloud and local agents with the memory_palace experiment off", async () => {
    expect(experimentManager.isEnabled("memory_palace")).toBe(false);

    for (const agentId of ["agent-123", "agent-local-123"]) {
      const payload = await buildClientSkillsPayload({
        agentId,
        skillSources: ["bundled"],
        attachedRepositories: [],
      });
      expect(payload.availableSkills.some((s) => s.name === SKILL_ID)).toBe(
        true,
      );

      const { content } = await readSkillContent(
        SKILL_ID,
        "/tmp/no-project-skills",
        agentId,
        { attachedRepositories: [] },
      );
      expect(content).toContain("palace/MEMORY.md");
      expect(content).toContain("palace-action");

      const discovery = await discoverSkills(
        "/tmp/no-project-skills",
        agentId,
        { sources: ["bundled"] },
      );
      expect(discovery.skills.some((s) => s.id === SKILL_ID)).toBe(true);
    }
  });
});
