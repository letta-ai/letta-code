import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithRuntimeContext } from "@/runtime-context";
import { consumeQueuedSkillContent } from "@/tools/impl/skill-content-registry";
import { clearTools, executeTool, loadSpecificTools } from "@/tools/manager";

const TEST_AGENT_ID = "agent-skill-memfs-test";
let currentSkillsDirectory: string | null = null;

const { readSkillContent, renderSkillContent, skill, wrapSkillContent } =
  await import("@/tools/impl/skill");

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
  const originalLocalBackendExperimental =
    process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
  const originalHome = process.env.HOME;
  const originalUserCwd = process.env.USER_CWD;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "letta-skill-tool-"));
    currentSkillsDirectory = join(tempRoot, ".skills");
    delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
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

    if (originalLocalBackendExperimental === undefined) {
      delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
    } else {
      process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL =
        originalLocalBackendExperimental;
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

  test("does not load bundled image generation skill for local agents", async () => {
    process.env.MEMORY_DIR = join(tempRoot, "empty-memory");
    process.env.LETTA_MEMORY_DIR = join(tempRoot, "empty-letta-memory");
    process.env.HOME = tempRoot;

    await expect(
      readSkillContent(
        "image-generation",
        currentSkillsDirectory ?? join(tempRoot, ".skills"),
        "agent-local-skill-test",
      ),
    ).rejects.toThrow('Skill "image-generation" not found');
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

  test("does not load legacy ~/.letta/agents/<id>/skills entries", async () => {
    const skillName = "legacy-agent-skill";
    const skillDir = join(
      tempRoot,
      ".letta",
      "agents",
      TEST_AGENT_ID,
      "skills",
      skillName,
    );

    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: legacy-agent-skill\ndescription: test\n---\n\nLoaded from legacy agent skills.",
      "utf8",
    );

    delete process.env.MEMORY_DIR;
    delete process.env.LETTA_MEMORY_DIR;
    process.env.HOME = tempRoot;

    await expect(
      runScopedSkill({
        skill: skillName,
        toolCallId: "tc-legacy-agent-skill",
      }),
    ).rejects.toThrow(skillName);

    expect(consumeQueuedSkillContent()).toHaveLength(0);
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

  test("loads canonical .agents/skills project skills before legacy .skills", async () => {
    const skillName = "canonical-project-skill";
    const projectRoot = join(tempRoot, "project-root");
    const canonicalSkillDir = join(projectRoot, ".agents", "skills", skillName);
    const legacySkillDir = join(projectRoot, ".skills", skillName);

    currentSkillsDirectory = join(projectRoot, ".skills");
    mkdirSync(canonicalSkillDir, { recursive: true });
    mkdirSync(legacySkillDir, { recursive: true });
    writeFileSync(
      join(canonicalSkillDir, "SKILL.md"),
      "---\nname: canonical-project-skill\ndescription: canonical\n---\n\nLoaded from .agents/skills.",
      "utf8",
    );
    writeFileSync(
      join(legacySkillDir, "SKILL.md"),
      "---\nname: canonical-project-skill\ndescription: legacy\n---\n\nLoaded from .skills.",
      "utf8",
    );

    process.env.USER_CWD = projectRoot;

    const result = await runScopedSkill({
      skill: skillName,
      toolCallId: "tc-canonical-project",
    });
    expect(result.message).toBe(`Launching skill: ${skillName}`);

    const queued = consumeQueuedSkillContent();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toContain("Loaded from .agents/skills.");
    expect(queued[0]?.content).not.toContain("Loaded from .skills.");
  });

  test("renders skill arguments and skill directory substitutions", () => {
    const rendered = renderSkillContent(
      "deploy",
      [
        "---",
        "name: deploy",
        "description: deploy",
        "arguments: environment version",
        "---",
        "",
        "Deploy $environment at $version from $" +
          "{CLAUDE_SKILL_DIR}; all=$ARGUMENTS first=$0 second=$ARGUMENTS[1].",
      ].join("\n"),
      join(tempRoot, "deploy", "SKILL.md"),
      { args: "prod v1" },
    );

    expect(rendered).toContain("Deploy prod at v1");
    expect(rendered).toContain("all=prod v1");
    expect(rendered).toContain("first=prod");
    expect(rendered).toContain("second=v1");
    expect(rendered).toContain(join(tempRoot, "deploy"));
  });

  test("appends arguments when no placeholder is present", () => {
    const rendered = renderSkillContent(
      "review",
      "---\nname: review\ndescription: review\n---\n\nReview the code.",
      join(tempRoot, "review", "SKILL.md"),
      { args: "src/index.ts" },
    );

    expect(rendered).toContain("Review the code.");
    expect(rendered).toContain("ARGUMENTS: src/index.ts");
  });

  test("blocks model invocation for manual-only skills unless explicitly allowed", () => {
    const content =
      "---\nname: deploy\ndescription: deploy\ndisable-model-invocation: true\n---\n\nDeploy.";
    expect(() =>
      renderSkillContent(
        "deploy",
        content,
        join(tempRoot, "deploy", "SKILL.md"),
      ),
    ).toThrow("disable-model-invocation");

    expect(
      renderSkillContent(
        "deploy",
        content,
        join(tempRoot, "deploy", "SKILL.md"),
        {
          allowDisabledModelInvocation: true,
        },
      ),
    ).toContain("Deploy.");
  });

  test("wraps slash-containing skill names in a safe XML envelope", () => {
    const wrapped = wrapSkillContent(
      "integrations/oauth/letta-oauth",
      "Use OAuth.",
    );

    expect(wrapped).toContain('<skill name="integrations/oauth/letta-oauth">');
    expect(wrapped).toContain("Use OAuth.");
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
