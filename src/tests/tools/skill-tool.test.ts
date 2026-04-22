import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithRuntimeContext } from "../../runtime-context";
import { consumeQueuedSkillContent } from "../../tools/impl/skillContentRegistry";
import {
  clearTools,
  executeTool,
  loadSpecificTools,
} from "../../tools/manager";

const TEST_AGENT_ID = "agent-skill-memfs-test";
let currentSkillsDirectory: string | null = null;

const { skill } = await import("../../tools/impl/Skill");

function withSkillContext<T>(fn: () => Promise<T>) {
  return runWithRuntimeContext(
    {
      agentId: TEST_AGENT_ID,
      skillsDirectory: currentSkillsDirectory,
    },
    fn,
  );
}

function runScopedSkill(args: Parameters<typeof skill>[0]) {
  return withSkillContext(() => skill(args));
}

describe("Skill tool memory filesystem lookup", () => {
  let tempRoot: string;
  const originalMemoryDir = process.env.MEMORY_DIR;
  const originalLettaMemoryDir = process.env.LETTA_MEMORY_DIR;
  const originalHome = process.env.HOME;
  const originalUserCwd = process.env.USER_CWD;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "letta-skill-tool-"));
    currentSkillsDirectory = join(tempRoot, ".skills");
    consumeQueuedSkillContent();
  });

  afterEach(() => {
    consumeQueuedSkillContent();
    currentSkillsDirectory = null;
    clearTools();

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

    if (originalUserCwd === undefined) {
      delete process.env.USER_CWD;
    } else {
      process.env.USER_CWD = originalUserCwd;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("loads skills from MEMORY_DIR/skills", async () => {
    const skillName = "memfs-only-skill";
    const memoryDir = join(tempRoot, "memory");
    const skillDir = join(memoryDir, "skills", skillName);

    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: memfs-only-skill\ndescription: test\n---\n\nLoaded from MEMORY_DIR.",
      "utf8",
    );

    process.env.MEMORY_DIR = memoryDir;
    delete process.env.LETTA_MEMORY_DIR;

    const result = await runScopedSkill({
      skill: skillName,
      toolCallId: "tc-memory-dir",
    });
    expect(result.message).toBe(`Launching skill: ${skillName}`);

    const queued = consumeQueuedSkillContent();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toContain("Loaded from MEMORY_DIR.");
  });

  test("prefers scoped agent memory skills over stale MEMORY_DIR env", async () => {
    const skillName = "scoped-over-stale-memory-skill";
    const staleMemoryDir = join(tempRoot, "stale-memory");
    const staleSkillDir = join(staleMemoryDir, "skills", skillName);
    const scopedSkillDir = join(
      tempRoot,
      ".letta",
      "agents",
      TEST_AGENT_ID,
      "memory",
      "skills",
      skillName,
    );

    mkdirSync(staleSkillDir, { recursive: true });
    mkdirSync(scopedSkillDir, { recursive: true });
    writeFileSync(
      join(staleSkillDir, "SKILL.md"),
      "---\nname: scoped-over-stale-memory-skill\ndescription: stale\n---\n\nLoaded from stale MEMORY_DIR.",
      "utf8",
    );
    writeFileSync(
      join(scopedSkillDir, "SKILL.md"),
      "---\nname: scoped-over-stale-memory-skill\ndescription: scoped\n---\n\nLoaded from scoped agent memory.",
      "utf8",
    );

    process.env.MEMORY_DIR = staleMemoryDir;
    delete process.env.LETTA_MEMORY_DIR;
    process.env.HOME = tempRoot;

    const result = await runScopedSkill({
      skill: skillName,
      toolCallId: "tc-scoped-over-stale",
    });
    expect(result.message).toBe(`Launching skill: ${skillName}`);

    const queued = consumeQueuedSkillContent();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toContain("Loaded from scoped agent memory.");
    expect(queued[0]?.content).not.toContain("Loaded from stale MEMORY_DIR.");
  });

  test("does not load env-only memory skill when scoped agent memory is present", async () => {
    const skillName = "env-only-stale-skill";
    const staleMemoryDir = join(tempRoot, "stale-memory");
    const staleSkillDir = join(staleMemoryDir, "skills", skillName);
    const scopedMemorySkillsDir = join(
      tempRoot,
      ".letta",
      "agents",
      TEST_AGENT_ID,
      "memory",
      "skills",
    );

    mkdirSync(staleSkillDir, { recursive: true });
    mkdirSync(scopedMemorySkillsDir, { recursive: true });
    writeFileSync(
      join(staleSkillDir, "SKILL.md"),
      "---\nname: env-only-stale-skill\ndescription: stale\n---\n\nLoaded from stale MEMORY_DIR only.",
      "utf8",
    );

    process.env.MEMORY_DIR = staleMemoryDir;
    delete process.env.LETTA_MEMORY_DIR;
    process.env.HOME = tempRoot;

    await expect(
      runScopedSkill({
        skill: skillName,
        toolCallId: "tc-env-only-stale",
      }),
    ).rejects.toThrow(skillName);

    expect(consumeQueuedSkillContent()).toHaveLength(0);
  });

  test("falls back to ~/.letta/agents/<id>/memory/skills when MEMORY_DIR is unset", async () => {
    const skillName = "agent-memory-fallback-skill";
    const skillDir = join(
      tempRoot,
      ".letta",
      "agents",
      TEST_AGENT_ID,
      "memory",
      "skills",
      skillName,
    );

    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: agent-memory-fallback-skill\ndescription: test\n---\n\nLoaded from agent memory fallback.",
      "utf8",
    );

    delete process.env.MEMORY_DIR;
    delete process.env.LETTA_MEMORY_DIR;
    process.env.HOME = tempRoot;

    const result = await runScopedSkill({
      skill: skillName,
      toolCallId: "tc-memory-fallback",
    });
    expect(result.message).toBe(`Launching skill: ${skillName}`);

    const queued = consumeQueuedSkillContent();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toContain("Loaded from agent memory fallback.");
  });

  test("prefers injected parentScope.agentId over global agent context for memfs fallback", async () => {
    const skillName = "scoped-agent-skill";
    const injectedAgentId = "agent-scoped-parent";
    const skillDir = join(
      tempRoot,
      ".letta",
      "agents",
      injectedAgentId,
      "memory",
      "skills",
      skillName,
    );

    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: scoped-agent-skill\ndescription: test\n---\n\nLoaded from injected agent scope.",
      "utf8",
    );

    delete process.env.MEMORY_DIR;
    delete process.env.LETTA_MEMORY_DIR;
    process.env.HOME = tempRoot;

    const result = await runScopedSkill({
      skill: skillName,
      toolCallId: "tc-scoped-agent",
      parentScope: {
        agentId: injectedAgentId,
        conversationId: "conversation-scoped-parent",
      },
    });
    expect(result.message).toBe(`Launching skill: ${skillName}`);

    const queued = consumeQueuedSkillContent();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toContain("Loaded from injected agent scope.");
  });

  test("uses USER_CWD fallback for project skill lookup when no explicit skills directory is set", async () => {
    const skillName = "cwd-project-skill";
    const projectRoot = join(tempRoot, "project-root");
    const skillDir = join(projectRoot, ".skills", skillName);

    currentSkillsDirectory = null;
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: cwd-project-skill\ndescription: test\n---\n\nLoaded from USER_CWD project skills.",
      "utf8",
    );

    process.env.USER_CWD = projectRoot;

    const result = await runScopedSkill({
      skill: skillName,
      toolCallId: "tc-user-cwd",
    });
    expect(result.message).toBe(`Launching skill: ${skillName}`);

    const queued = consumeQueuedSkillContent();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toContain(
      "Loaded from USER_CWD project skills.",
    );
  });

  test("executeTool forwards parentScope to Skill for listener-scoped memfs lookup", async () => {
    const skillName = "execute-tool-scoped-skill";
    const injectedAgentId = "agent-execute-tool-parent";
    const skillDir = join(
      tempRoot,
      ".letta",
      "agents",
      injectedAgentId,
      "memory",
      "skills",
      skillName,
    );

    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: execute-tool-scoped-skill\ndescription: test\n---\n\nLoaded through executeTool parent scope.",
      "utf8",
    );

    delete process.env.MEMORY_DIR;
    delete process.env.LETTA_MEMORY_DIR;
    process.env.HOME = tempRoot;

    clearTools();
    await loadSpecificTools(["Skill"]);

    const result = await withSkillContext(() =>
      executeTool(
        "Skill",
        { skill: skillName },
        {
          toolCallId: "tc-execute-tool-scoped",
          parentScope: {
            agentId: injectedAgentId,
            conversationId: "conversation-execute-tool",
          },
        },
      ),
    );

    expect(result.status).toBe("success");
    expect(result.toolReturn).toBe(`Launching skill: ${skillName}`);

    const queued = consumeQueuedSkillContent();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toContain(
      "Loaded through executeTool parent scope.",
    );
  });
});
