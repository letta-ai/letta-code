import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMemoryRepoDir } from "../../agent/memoryGit";
import {
  discoverSkills,
  getAgentMemfsSkillsDir,
  getAgentSkillsDir,
  getEffectiveAgentSkillsDir,
} from "../../agent/skills";
import { settingsManager } from "../../settings-manager";

describe("agent-scoped skills path with memfs", () => {
  const agentId = "agent-memfs-skills-test";
  let tempHome: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeEach(async () => {
    tempHome = mkdtempSync(join(process.cwd(), ".tmp-home-"));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    await settingsManager.reset();
    await settingsManager.initialize();
  });

  afterEach(async () => {
    await settingsManager.reset();

    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }

    if (prevUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = prevUserProfile;
    }

    rmSync(tempHome, { recursive: true, force: true });
  });

  test("uses legacy agent skills dir when memfs disabled", () => {
    settingsManager.setMemfsEnabled(agentId, false);

    const path = getEffectiveAgentSkillsDir(agentId);
    expect(path).toBe(join(tempHome, ".letta", "agents", agentId, "skills"));
  });

  test("uses memory repo skills dir when memfs enabled", () => {
    settingsManager.setMemfsEnabled(agentId, true);

    const path = getEffectiveAgentSkillsDir(agentId);
    expect(path).toBe(join(getMemoryRepoDir(agentId), "skills"));
    expect(path).toBe(getAgentMemfsSkillsDir(agentId));
  });

  test("discoverSkills reads agent skills from memory repo when memfs enabled", async () => {
    settingsManager.setMemfsEnabled(agentId, true);

    const skillDir = join(getAgentMemfsSkillsDir(agentId), "memfs-only-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: memfs-only-skill\ndescription: from memfs\n---\n\n# MemFS Skill\n",
    );

    const result = await discoverSkills(
      join(tempHome, ".no-project-skills"),
      agentId,
      {
        skipBundled: true,
        sources: ["agent"],
      },
    );

    expect(result.skills.some((s) => s.id === "memfs-only-skill")).toBe(true);
  });

  test("discoverSkills reads agent skills from legacy dir when memfs disabled", async () => {
    settingsManager.setMemfsEnabled(agentId, false);

    const skillDir = join(getAgentSkillsDir(agentId), "legacy-agent-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: legacy-agent-skill\ndescription: from legacy dir\n---\n\n# Legacy Skill\n",
    );

    const result = await discoverSkills(
      join(tempHome, ".no-project-skills"),
      agentId,
      {
        skipBundled: true,
        sources: ["agent"],
      },
    );

    expect(result.skills.some((s) => s.id === "legacy-agent-skill")).toBe(true);
  });
});
