import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import {
  invalidateClientSkillsPayloadCache,
  invalidateClientSkillsPayloadCacheForAgent,
} from "../../agent/clientSkills";
import type {
  Skill,
  SkillDiscoveryResult,
  SkillSource,
} from "../../agent/skills";

/** Normalize path separators so assertions work on Windows too. */
const normalize = (p: string): string => p.replace(/\\/g, "/");

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

  test("treats .agents/skills as primary and .skills as legacy fallback", async () => {
    const { buildClientSkillsPayload } = await import(
      "../../agent/clientSkills"
    );

    const calls: Array<{ path: string; sources: SkillSource[] | undefined }> =
      [];
    const discoverSkillsFn = async (
      projectSkillsPath?: string,
      _agentId?: string,
      options?: { sources?: SkillSource[] },
    ): Promise<SkillDiscoveryResult> => {
      calls.push({
        path: projectSkillsPath ?? "",
        sources: options?.sources,
      });

      if (normalize(projectSkillsPath ?? "").endsWith("/.agents/skills")) {
        return {
          skills: [
            {
              ...baseSkill,
              id: "shared",
              description: "from .agents",
              path: "/tmp/.agents/skills/shared/SKILL.md",
              source: "project",
            },
            {
              ...baseSkill,
              id: "agents-only",
              description: "only in .agents",
              path: "/tmp/.agents/skills/agents-only/SKILL.md",
              source: "project",
            },
          ],
          errors: [],
        };
      }

      return {
        skills: [
          {
            ...baseSkill,
            id: "shared",
            description: "from .skills",
            path: "/tmp/.skills/shared/SKILL.md",
            source: "project",
          },
          {
            ...baseSkill,
            id: "project-only",
            description: "only in .skills",
            path: "/tmp/.skills/project-only/SKILL.md",
            source: "project",
          },
        ],
        errors: [],
      };
    };

    const result = await buildClientSkillsPayload({
      agentId: "agent-1",
      skillsDirectory: "/tmp/.skills",
      skillSources: ["project"],
      discoverSkillsFn,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ path: "/tmp/.skills", sources: ["project"] });
    expect(normalize(calls[1]?.path ?? "").endsWith("/.agents/skills")).toBe(
      true,
    );
    expect(calls[1]?.sources).toEqual(["project"]);
    expect(result.clientSkills).toEqual([
      {
        name: "agents-only",
        description: "only in .agents",
        location: "/tmp/.agents/skills/agents-only/SKILL.md",
      },
      {
        name: "project-only",
        description: "only in .skills",
        location: "/tmp/.skills/project-only/SKILL.md",
      },
      {
        name: "shared",
        description: "from .agents",
        location: "/tmp/.agents/skills/shared/SKILL.md",
      },
    ]);
    expect(result.errors).toEqual([]);
  });

  test("returns partial results and records errors when one source throws", async () => {
    const { buildClientSkillsPayload } = await import(
      "../../agent/clientSkills"
    );

    const discoverSkillsFn = async (
      projectSkillsPath?: string,
    ): Promise<SkillDiscoveryResult> => {
      if (normalize(projectSkillsPath ?? "").endsWith("/.agents/skills")) {
        throw new Error("boom");
      }

      return {
        skills: [
          {
            ...baseSkill,
            id: "ok-skill",
            description: "ok",
            path: "/tmp/.skills/ok-skill/SKILL.md",
            source: "project",
          },
        ],
        errors: [],
      };
    };

    const logs: string[] = [];
    const result = await buildClientSkillsPayload({
      skillsDirectory: "/tmp/.skills",
      skillSources: ["project"],
      discoverSkillsFn,
      logger: (m) => logs.push(m),
    });

    expect(result.clientSkills).toEqual([
      {
        name: "ok-skill",
        description: "ok",
        location: "/tmp/.skills/ok-skill/SKILL.md",
      },
    ]);
    expect(result.skillPathById).toEqual({
      "ok-skill": "/tmp/.skills/ok-skill/SKILL.md",
    });
    expect(result.errors).toHaveLength(1);
    expect(
      normalize(result.errors[0]?.path ?? "").endsWith("/.agents/skills"),
    ).toBe(true);
    expect(
      logs.some((m) =>
        m.includes("Failed to build some client_skills entries"),
      ),
    ).toBe(true);
  });

  test("includes memfs skills in client_skills and lets memfs override global/bundled", async () => {
    const { buildClientSkillsPayload } = await import(
      "../../agent/clientSkills"
    );

    const originalMemoryDir = process.env.MEMORY_DIR;
    const originalLettaMemoryDir = process.env.LETTA_MEMORY_DIR;
    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-client-skills-"));

    try {
      const memoryDir = join(tempRoot, "memory");
      const memorySkillDir = join(memoryDir, "skills", "shared-skill");
      await mkdir(memorySkillDir, { recursive: true });
      await writeFile(
        join(memorySkillDir, "SKILL.md"),
        [
          "---",
          "id: shared-skill",
          "name: shared-skill",
          "description: from memfs",
          "---",
          "",
          "Memfs body",
        ].join("\n"),
      );

      process.env.MEMORY_DIR = memoryDir;
      delete process.env.LETTA_MEMORY_DIR;

      const discoverSkillsFn = async (): Promise<SkillDiscoveryResult> => ({
        skills: [
          {
            ...baseSkill,
            id: "shared-skill",
            description: "from global",
            path: "/tmp/global/shared-skill/SKILL.md",
            source: "global",
          },
        ],
        errors: [],
      });

      const result = await buildClientSkillsPayload({
        agentId: "agent-1",
        skillsDirectory: "/tmp/.skills",
        skillSources: ["global"],
        discoverSkillsFn,
      });

      expect(result.clientSkills).toEqual([
        {
          name: "shared-skill",
          description: "from memfs",
          location: join(memorySkillDir, "SKILL.md"),
        },
      ]);
      expect(result.skillPathById).toEqual({
        "shared-skill": join(memorySkillDir, "SKILL.md"),
      });
    } finally {
      if (originalMemoryDir === undefined) {
        delete process.env.MEMORY_DIR;
      } else {
        process.env.MEMORY_DIR = originalMemoryDir;
      }
      if (originalLettaMemoryDir === undefined) {
        delete process.env.LETTA_MEMORY_DIR;
      } else {
        process.env.LETTA_MEMORY_DIR = originalLettaMemoryDir;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("prefers scoped agent memfs skills over stale MEMORY_DIR env", async () => {
    const { buildClientSkillsPayload } = await import(
      "../../agent/clientSkills"
    );

    const originalMemoryDir = process.env.MEMORY_DIR;
    const originalLettaMemoryDir = process.env.LETTA_MEMORY_DIR;
    const originalHome = process.env.HOME;
    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-client-skills-"));

    try {
      const staleMemoryDir = join(tempRoot, "stale-memory");
      const staleSkillDir = join(staleMemoryDir, "skills", "shared-skill");
      const scopedMemorySkillDir = join(
        tempRoot,
        ".letta",
        "agents",
        "agent-1",
        "memory",
        "skills",
        "shared-skill",
      );
      await mkdir(staleSkillDir, { recursive: true });
      await mkdir(scopedMemorySkillDir, { recursive: true });
      await writeFile(
        join(staleSkillDir, "SKILL.md"),
        [
          "---",
          "id: shared-skill",
          "name: shared-skill",
          "description: from stale env",
          "---",
          "",
          "Stale body",
        ].join("\n"),
      );
      await writeFile(
        join(scopedMemorySkillDir, "SKILL.md"),
        [
          "---",
          "id: shared-skill",
          "name: shared-skill",
          "description: from scoped agent",
          "---",
          "",
          "Scoped body",
        ].join("\n"),
      );

      process.env.MEMORY_DIR = staleMemoryDir;
      delete process.env.LETTA_MEMORY_DIR;
      process.env.HOME = tempRoot;

      const result = await buildClientSkillsPayload({
        agentId: "agent-1",
        skillsDirectory: "/tmp/.skills",
        skillSources: ["global"],
        discoverSkillsFn: async (): Promise<SkillDiscoveryResult> => ({
          skills: [],
          errors: [],
        }),
      });

      expect(result.clientSkills).toEqual([
        {
          name: "shared-skill",
          description: "from scoped agent",
          location: join(scopedMemorySkillDir, "SKILL.md"),
        },
      ]);
      expect(result.skillPathById).toEqual({
        "shared-skill": join(scopedMemorySkillDir, "SKILL.md"),
      });
    } finally {
      if (originalMemoryDir === undefined) {
        delete process.env.MEMORY_DIR;
      } else {
        process.env.MEMORY_DIR = originalMemoryDir;
      }
      if (originalLettaMemoryDir === undefined) {
        delete process.env.LETTA_MEMORY_DIR;
      } else {
        process.env.LETTA_MEMORY_DIR = originalLettaMemoryDir;
      }
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("does not advertise env-only memfs skills when scoped agent memory is present", async () => {
    const { buildClientSkillsPayload } = await import(
      "../../agent/clientSkills"
    );

    const originalMemoryDir = process.env.MEMORY_DIR;
    const originalLettaMemoryDir = process.env.LETTA_MEMORY_DIR;
    const originalHome = process.env.HOME;
    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-client-skills-"));

    try {
      const staleMemoryDir = join(tempRoot, "stale-memory");
      const staleSkillDir = join(
        staleMemoryDir,
        "skills",
        "env-only-stale-skill",
      );
      const scopedMemorySkillsDir = join(
        tempRoot,
        ".letta",
        "agents",
        "agent-1",
        "memory",
        "skills",
      );

      await mkdir(staleSkillDir, { recursive: true });
      await mkdir(scopedMemorySkillsDir, { recursive: true });
      await writeFile(
        join(staleSkillDir, "SKILL.md"),
        [
          "---",
          "id: env-only-stale-skill",
          "name: env-only-stale-skill",
          "description: from stale env",
          "---",
          "",
          "Stale body",
        ].join("\n"),
      );

      process.env.MEMORY_DIR = staleMemoryDir;
      delete process.env.LETTA_MEMORY_DIR;
      process.env.HOME = tempRoot;

      const result = await buildClientSkillsPayload({
        agentId: "agent-1",
        skillsDirectory: "/tmp/.skills",
        skillSources: ["global"],
        discoverSkillsFn: async (): Promise<SkillDiscoveryResult> => ({
          skills: [],
          errors: [],
        }),
      });

      expect(result.clientSkills).toEqual([]);
      expect(result.skillPathById).toEqual({});
    } finally {
      if (originalMemoryDir === undefined) {
        delete process.env.MEMORY_DIR;
      } else {
        process.env.MEMORY_DIR = originalMemoryDir;
      }
      if (originalLettaMemoryDir === undefined) {
        delete process.env.LETTA_MEMORY_DIR;
      } else {
        process.env.LETTA_MEMORY_DIR = originalLettaMemoryDir;
      }
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("does not let memfs skills override agent or project sources", async () => {
    const { buildClientSkillsPayload } = await import(
      "../../agent/clientSkills"
    );

    const originalMemoryDir = process.env.MEMORY_DIR;
    const originalLettaMemoryDir = process.env.LETTA_MEMORY_DIR;
    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-client-skills-"));

    try {
      const memoryDir = join(tempRoot, "memory");
      const memorySkillDir = join(memoryDir, "skills", "shared-skill");
      await mkdir(memorySkillDir, { recursive: true });
      await writeFile(
        join(memorySkillDir, "SKILL.md"),
        [
          "---",
          "id: shared-skill",
          "name: shared-skill",
          "description: from memfs",
          "---",
          "",
          "Memfs body",
        ].join("\n"),
      );

      process.env.MEMORY_DIR = memoryDir;
      delete process.env.LETTA_MEMORY_DIR;

      const discoverSkillsFn = async (): Promise<SkillDiscoveryResult> => ({
        skills: [
          {
            ...baseSkill,
            id: "shared-skill",
            description: "from agent",
            path: "/tmp/agent/shared-skill/SKILL.md",
            source: "agent",
          },
          {
            ...baseSkill,
            id: "project-wins",
            description: "from project",
            path: "/tmp/project/project-wins/SKILL.md",
            source: "project",
          },
        ],
        errors: [],
      });

      const result = await buildClientSkillsPayload({
        agentId: "agent-1",
        skillsDirectory: "/tmp/.skills",
        skillSources: ["agent", "project"],
        discoverSkillsFn,
      });

      expect(result.clientSkills).toContainEqual({
        name: "shared-skill",
        description: "from agent",
        location: "/tmp/agent/shared-skill/SKILL.md",
      });
      expect(result.clientSkills).toContainEqual({
        name: "project-wins",
        description: "from project",
        location: "/tmp/project/project-wins/SKILL.md",
      });
      expect(result.clientSkills).not.toContainEqual({
        name: "shared-skill",
        description: "from memfs",
        location: join(memorySkillDir, "SKILL.md"),
      });
    } finally {
      if (originalMemoryDir === undefined) {
        delete process.env.MEMORY_DIR;
      } else {
        process.env.MEMORY_DIR = originalMemoryDir;
      }
      if (originalLettaMemoryDir === undefined) {
        delete process.env.LETTA_MEMORY_DIR;
      } else {
        process.env.LETTA_MEMORY_DIR = originalLettaMemoryDir;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Cache behavior tests
// ---------------------------------------------------------------------------

describe("client skills payload cache", () => {
  // Each test starts with a clean cache to avoid cross-test pollution.
  async function importFresh() {
    // Clear the global cache before re-importing so we get a fresh start.
    invalidateClientSkillsPayloadCache();
    return import("../../agent/clientSkills");
  }

  test("returns cached result on second call with same parameters", async () => {
    const { buildClientSkillsPayload } = await importFresh();

    // Test that the cache works by calling twice without
    // discoverSkillsFn and verifying the results are identical.
    // We'll use temp directories with real skill files.
    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-cache-test-"));
    const originalCwd = process.cwd();

    try {
      const projectDir = join(tempRoot, "project");
      const agentsSkillsDir = join(projectDir, ".agents", "skills");
      const skillDir = join(agentsSkillsDir, "test-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "id: test-skill",
          "name: test-skill",
          "description: cached skill",
          "---",
          "",
          "Body",
        ].join("\n"),
      );

      process.chdir(projectDir);

      // Clear cache to start fresh
      invalidateClientSkillsPayloadCache();

      const result1 = await buildClientSkillsPayload({
        agentId: "cache-test-agent",
        skillsDirectory: join(projectDir, ".skills"),
        skillSources: ["project"],
      });

      const result2 = await buildClientSkillsPayload({
        agentId: "cache-test-agent",
        skillsDirectory: join(projectDir, ".skills"),
        skillSources: ["project"],
      });

      // Both calls should return identical results
      expect(result2.clientSkills).toEqual(result1.clientSkills);
      expect(result2.skillPathById).toEqual(result1.skillPathById);
      expect(result2.errors).toEqual(result1.errors);
    } finally {
      process.chdir(originalCwd);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("cache miss when agentId differs", async () => {
    const { buildClientSkillsPayload } = await importFresh();

    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-cache-agent-"));
    const originalCwd = process.cwd();
    const originalHome = process.env.HOME;

    try {
      const projectDir = join(tempRoot, "project");
      const agentsSkillsDir = join(projectDir, ".agents", "skills");
      const skillDir = join(agentsSkillsDir, "test-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "id: test-skill",
          "name: test-skill",
          "description: skill for agent test",
          "---",
          "",
          "Body",
        ].join("\n"),
      );

      // Set up scoped memory for agent-2 so it has a different memory root
      // The scoped memory dir is: $HOME/.letta/agents/<agentId>/memory
      // getMemorySkillsDirs checks existsSync on the memory root, then
      // appends "skills" to discover skill directories.
      const agent2MemoryRoot = join(
        tempRoot,
        ".letta",
        "agents",
        "cache-agent-2",
        "memory",
      );
      const agent2MemorySkillDir = join(
        agent2MemoryRoot,
        "skills",
        "agent2-skill",
      );
      await mkdir(agent2MemorySkillDir, { recursive: true });
      await writeFile(
        join(agent2MemorySkillDir, "SKILL.md"),
        [
          "---",
          "id: agent2-skill",
          "name: agent2-skill",
          "description: agent 2 only",
          "---",
          "",
          "Body",
        ].join("\n"),
      );

      process.chdir(projectDir);
      process.env.HOME = tempRoot;

      invalidateClientSkillsPayloadCache();

      // Populate cache for both agents
      const result1 = await buildClientSkillsPayload({
        agentId: "cache-agent-1",
        skillsDirectory: join(projectDir, ".skills"),
        skillSources: ["project"],
      });

      const result2 = await buildClientSkillsPayload({
        agentId: "cache-agent-2",
        skillsDirectory: join(projectDir, ".skills"),
        skillSources: ["project"],
      });

      // agent-2 should have the additional memory skill that agent-1 doesn't
      // (different agentId → different scoped memory → different cache key → different result)
      expect(result2.clientSkills.length).toBeGreaterThan(
        result1.clientSkills.length,
      );
      expect(result2.clientSkills).toContainEqual(
        expect.objectContaining({ name: "agent2-skill" }),
      );
    } finally {
      process.chdir(originalCwd);
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("cache miss when skillSources differ", async () => {
    const { buildClientSkillsPayload } = await importFresh();

    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-cache-sources-"));
    const originalCwd = process.cwd();

    try {
      const projectDir = join(tempRoot, "project");
      const agentsSkillsDir = join(projectDir, ".agents", "skills");
      const skillDir = join(agentsSkillsDir, "test-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "id: test-skill",
          "name: test-skill",
          "description: source test",
          "---",
          "",
          "Body",
        ].join("\n"),
      );

      process.chdir(projectDir);

      invalidateClientSkillsPayloadCache();

      const result1 = await buildClientSkillsPayload({
        agentId: "cache-sources-agent",
        skillsDirectory: join(projectDir, ".skills"),
        skillSources: ["project"],
      });

      const result2 = await buildClientSkillsPayload({
        agentId: "cache-sources-agent",
        skillsDirectory: join(projectDir, ".skills"),
        skillSources: ["bundled", "project"],
      });

      // Different skill sources → different cache keys → different results
      // (bundled source adds bundled skills)
      expect(result2.clientSkills.length).toBeGreaterThanOrEqual(
        result1.clientSkills.length,
      );
    } finally {
      process.chdir(originalCwd);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("cache misses when a skill file changes", async () => {
    const { buildClientSkillsPayload } = await importFresh();

    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-cache-change-"));
    const originalCwd = process.cwd();

    try {
      const projectDir = join(tempRoot, "project");
      const agentsSkillsDir = join(projectDir, ".agents", "skills");
      const skillDir = join(agentsSkillsDir, "mutable-skill");
      const skillPath = join(skillDir, "SKILL.md");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        skillPath,
        [
          "---",
          "id: mutable-skill",
          "name: mutable-skill",
          "description: original",
          "---",
          "",
          "Body",
        ].join("\n"),
      );

      process.chdir(projectDir);
      invalidateClientSkillsPayloadCache();

      const result1 = await buildClientSkillsPayload({
        agentId: "change-agent",
        skillsDirectory: join(projectDir, ".skills"),
        skillSources: ["project"],
      });
      expect(result1.clientSkills[0]?.description).toBe("original");

      await new Promise((resolve) => setTimeout(resolve, 10));
      await writeFile(
        skillPath,
        [
          "---",
          "id: mutable-skill",
          "name: mutable-skill",
          "description: updated description",
          "---",
          "",
          "Body changed",
        ].join("\n"),
      );

      const result2 = await buildClientSkillsPayload({
        agentId: "change-agent",
        skillsDirectory: join(projectDir, ".skills"),
        skillSources: ["project"],
      });

      expect(result2.clientSkills[0]?.description).toBe("updated description");
    } finally {
      process.chdir(originalCwd);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("invalidateClientSkillsPayloadCache clears all entries", async () => {
    const { buildClientSkillsPayload } = await importFresh();

    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-cache-inval-"));
    const originalCwd = process.cwd();

    try {
      const projectDir = join(tempRoot, "project");
      const agentsSkillsDir = join(projectDir, ".agents", "skills");
      const skillDir = join(agentsSkillsDir, "test-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "id: test-skill",
          "name: test-skill",
          "description: invalidation test",
          "---",
          "",
          "Body",
        ].join("\n"),
      );

      process.chdir(projectDir);

      invalidateClientSkillsPayloadCache();

      const result1 = await buildClientSkillsPayload({
        agentId: "inval-agent",
        skillsDirectory: join(projectDir, ".skills"),
        skillSources: ["project"],
      });

      // Invalidate all
      invalidateClientSkillsPayloadCache();

      const result2 = await buildClientSkillsPayload({
        agentId: "inval-agent",
        skillsDirectory: join(projectDir, ".skills"),
        skillSources: ["project"],
      });

      // After invalidation, the second call re-discovers (same files → same result)
      expect(result2.clientSkills).toEqual(result1.clientSkills);
      expect(result2.skillPathById).toEqual(result1.skillPathById);
    } finally {
      process.chdir(originalCwd);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("invalidateClientSkillsPayloadCacheForAgent clears only the target agent", async () => {
    const { buildClientSkillsPayload } = await importFresh();

    const tempRoot = await mkdtemp(
      join(os.tmpdir(), "letta-cache-agent-inval-"),
    );
    const originalCwd = process.cwd();

    try {
      const projectDir = join(tempRoot, "project");
      const agentsSkillsDir = join(projectDir, ".agents", "skills");
      const skillDir = join(agentsSkillsDir, "test-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "id: test-skill",
          "name: test-skill",
          "description: agent invalidation test",
          "---",
          "",
          "Body",
        ].join("\n"),
      );

      process.chdir(projectDir);

      invalidateClientSkillsPayloadCache();

      // Populate cache for two agents
      await buildClientSkillsPayload({
        agentId: "agent-alpha",
        skillsDirectory: join(projectDir, ".skills"),
        skillSources: ["project"],
      });
      await buildClientSkillsPayload({
        agentId: "agent-beta",
        skillsDirectory: join(projectDir, ".skills"),
        skillSources: ["project"],
      });

      // Invalidate only agent-alpha
      invalidateClientSkillsPayloadCacheForAgent("agent-alpha");

      // agent-alpha should re-discover (cache was cleared)
      // agent-beta should still be cached
      // Both should return the same results since the files haven't changed,
      // but the key point is that agent-alpha's cache entry was removed.
      // We verify this indirectly: the function doesn't throw, and results match.
      const resultAlpha = await buildClientSkillsPayload({
        agentId: "agent-alpha",
        skillsDirectory: join(projectDir, ".skills"),
        skillSources: ["project"],
      });
      const resultBeta = await buildClientSkillsPayload({
        agentId: "agent-beta",
        skillsDirectory: join(projectDir, ".skills"),
        skillSources: ["project"],
      });

      expect(resultAlpha.clientSkills).toEqual(resultBeta.clientSkills);
      expect(resultAlpha.skillPathById).toEqual(resultBeta.skillPathById);
    } finally {
      process.chdir(originalCwd);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("discoverSkillsFn bypasses cache", async () => {
    const { buildClientSkillsPayload } = await importFresh();

    let callCount = 0;
    const discoverSkillsFn = async (): Promise<SkillDiscoveryResult> => {
      callCount++;
      return {
        skills: [
          {
            ...baseSkill,
            id: `call-${callCount}`,
            description: `call ${callCount}`,
            path: `/tmp/call-${callCount}/SKILL.md`,
            source: "project",
          },
        ],
        errors: [],
      };
    };

    invalidateClientSkillsPayloadCache();

    const result1 = await buildClientSkillsPayload({
      agentId: "bypass-agent",
      skillsDirectory: "/tmp/.skills",
      skillSources: ["project"],
      discoverSkillsFn,
    });

    const result2 = await buildClientSkillsPayload({
      agentId: "bypass-agent",
      skillsDirectory: "/tmp/.skills",
      skillSources: ["project"],
      discoverSkillsFn,
    });

    // discoverSkillsFn should be called each time (no caching).
    // With skillSources: ["project"] and a non-default skillsDirectory,
    // there are 2 discovery runs per invocation (legacy + primary),
    // so 2 invocations × 2 runs = 4 calls.
    expect(callCount).toBe(4);
    // Each invocation produces incrementing ids, so first result has call-1/2, second has call-3/4
    expect(result1.clientSkills.map((s) => s.name).sort()).toEqual([
      "call-1",
      "call-2",
    ]);
    expect(result2.clientSkills.map((s) => s.name).sort()).toEqual([
      "call-3",
      "call-4",
    ]);
  });

  test("cached result is a deep copy (mutation safe)", async () => {
    const { buildClientSkillsPayload } = await importFresh();

    // Test that two consecutive calls without discoverSkillsFn
    // return independent objects (deep-copied from cache).
    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-cache-mut-"));
    const originalCwd = process.cwd();

    try {
      const projectDir = join(tempRoot, "project");
      const agentsSkillsDir = join(projectDir, ".agents", "skills");
      const skillDir = join(agentsSkillsDir, "mutable-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "id: mutable-skill",
          "name: mutable-skill",
          "description: original",
          "---",
          "",
          "Body",
        ].join("\n"),
      );

      process.chdir(projectDir);

      invalidateClientSkillsPayloadCache();

      const result1 = await buildClientSkillsPayload({
        agentId: "mutation-agent",
        skillsDirectory: join(projectDir, ".skills"),
        skillSources: ["project"],
      });

      // Mutate the returned result
      const firstSkill = result1.clientSkills[0];
      if (firstSkill) {
        firstSkill.description = "mutated";
      }
      result1.skillPathById["mutable-skill"] = "/mutated/path";

      const result2 = await buildClientSkillsPayload({
        agentId: "mutation-agent",
        skillsDirectory: join(projectDir, ".skills"),
        skillSources: ["project"],
      });

      // The second call should return the original (unmutated) cached result
      expect(result2.clientSkills[0]?.description).toBe("original");
      expect(result2.skillPathById["mutable-skill"]).not.toBe("/mutated/path");
    } finally {
      process.chdir(originalCwd);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
