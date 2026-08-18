import { afterEach, describe, expect, test } from "bun:test";
import { GIT_MEMORY_ENABLED_TAG, MEMFS_V2_TAG } from "@/agent/agent-tags";
import {
  buildClientSkillsPayload,
  invalidateClientSkillsPayloadCache,
} from "@/agent/client-skills";
import type { Skill, SkillDiscoveryResult } from "@/agent/skills";

const baseSkill: Skill = {
  id: "base",
  name: "Base",
  description: "Base skill",
  path: "/tmp/base/SKILL.md",
  source: "bundled",
};

afterEach(() => {
  invalidateClientSkillsPayloadCache();
});

describe("MemFS v2 client skills", () => {
  test("removes the migration skill from tagged local agent payloads", async () => {
    const discoverSkillsFn = async (): Promise<SkillDiscoveryResult> => ({
      skills: [
        {
          ...baseSkill,
          id: "upgrading-memory-filesystem",
          description: "Upgrade local memory",
          path: "/tmp/bundled/upgrading-memory-filesystem/SKILL.md",
        },
        {
          ...baseSkill,
          id: "safe-bundled",
          description: "Safe bundled skill",
          path: "/tmp/bundled/safe/SKILL.md",
        },
      ],
      errors: [],
    });

    const before = await buildClientSkillsPayload({
      agentId: "agent-local-123",
      agentTags: [GIT_MEMORY_ENABLED_TAG],
      skillsDirectory: "/tmp/.skills",
      skillSources: ["bundled"],
      discoverSkillsFn,
    });
    const after = await buildClientSkillsPayload({
      agentId: "agent-local-123",
      agentTags: [MEMFS_V2_TAG],
      skillsDirectory: "/tmp/.skills",
      skillSources: ["bundled"],
      discoverSkillsFn,
    });

    expect(before.clientSkills.map((skill) => skill.name)).toContain(
      "upgrading-memory-filesystem",
    );
    expect(after.clientSkills.map((skill) => skill.name)).toEqual([
      "safe-bundled",
    ]);
  });
});
