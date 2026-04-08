import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
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
