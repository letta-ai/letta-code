import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsManager } from "../../settings-manager";
import {
  ANTHROPIC_DEFAULT_TOOLS,
  clearToolsWithLock,
  GEMINI_PASCAL_TOOLS,
  getToolNames,
  loadSpecificTools,
  loadTools,
  OPENAI_PASCAL_TOOLS,
  prepareToolExecutionContextForModel,
} from "../../tools/manager";

const originalHome = process.env.HOME;
let testHomeDir: string;

beforeEach(async () => {
  await settingsManager.reset();
  clearToolsWithLock();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-plan-mode-test-"));
  process.env.HOME = testHomeDir;
  await settingsManager.initialize();
});

afterEach(async () => {
  clearToolsWithLock();
  await settingsManager.reset();
  await rm(testHomeDir, { recursive: true, force: true });
  process.env.HOME = originalHome;
});

describe("plan mode setting tool filtering", () => {
  test("default tool loading omits plan-mode tools when disabled", async () => {
    expect(settingsManager.isPlanModeEnabled()).toBe(false);

    await loadTools("anthropic/claude-sonnet-4");
    const tools = getToolNames();

    expect(tools).toContain("AskUserQuestion");
    expect(tools).not.toContain("EnterPlanMode");
    expect(tools).not.toContain("ExitPlanMode");
  });

  test("default tool loading includes plan-mode tools when enabled", async () => {
    settingsManager.setPlanModeEnabled(true);

    await loadTools("anthropic/claude-sonnet-4");
    const tools = getToolNames();

    expect(tools).toContain("AskUserQuestion");
    expect(tools).toContain("EnterPlanMode");
    expect(tools).toContain("ExitPlanMode");
  });

  test("specific tool loading omits plan-mode tools when disabled", async () => {
    await loadSpecificTools([...OPENAI_PASCAL_TOOLS]);
    const tools = getToolNames();

    expect(tools).toContain("AskUserQuestion");
    expect(tools).not.toContain("EnterPlanMode");
    expect(tools).not.toContain("ExitPlanMode");
  });

  test("Gemini Pascal tool loading omits plan-mode tools when disabled", async () => {
    await loadSpecificTools([...GEMINI_PASCAL_TOOLS]);
    const tools = getToolNames();

    expect(tools).toContain("AskUserQuestion");
    expect(tools).not.toContain("EnterPlanMode");
    expect(tools).not.toContain("ExitPlanMode");
  });

  test("specific tool loading includes plan-mode tools when enabled", async () => {
    settingsManager.setPlanModeEnabled(true);

    await loadSpecificTools([...OPENAI_PASCAL_TOOLS]);
    const tools = getToolNames();

    expect(tools).toContain("AskUserQuestion");
    expect(tools).toContain("EnterPlanMode");
    expect(tools).toContain("ExitPlanMode");
  });

  test("client allowlist cannot re-enable plan-mode tools", async () => {
    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      {
        clientToolAllowlist: [
          "AskUserQuestion",
          "EnterPlanMode",
          "ExitPlanMode",
        ],
      },
    );

    expect(prepared.loadedToolNames).toEqual(["AskUserQuestion"]);
  });

  test("source toolset lists keep plan tools for enabled mode", () => {
    expect(ANTHROPIC_DEFAULT_TOOLS).toContain("EnterPlanMode");
    expect(ANTHROPIC_DEFAULT_TOOLS).toContain("ExitPlanMode");
    expect(OPENAI_PASCAL_TOOLS).toContain("EnterPlanMode");
    expect(OPENAI_PASCAL_TOOLS).toContain("ExitPlanMode");
    expect(GEMINI_PASCAL_TOOLS).toContain("EnterPlanMode");
    expect(GEMINI_PASCAL_TOOLS).toContain("ExitPlanMode");
  });
});

describe("worktree tool setting tool filtering", () => {
  test("default tool loading includes CreateWorktree by default", async () => {
    expect(settingsManager.shouldIncludeWorktreeTool()).toBe(true);

    await loadTools("anthropic/claude-sonnet-4");
    const tools = getToolNames();

    expect(tools).toContain("CreateWorktree");
  });

  test("default tool loading omits CreateWorktree when disabled", async () => {
    settingsManager.setIncludeWorktreeTool(false);

    await loadTools("anthropic/claude-sonnet-4");
    const tools = getToolNames();

    expect(tools).not.toContain("CreateWorktree");
  });

  test("specific tool loading cannot re-enable CreateWorktree", async () => {
    settingsManager.setIncludeWorktreeTool(false);

    await loadSpecificTools(["AskUserQuestion", "CreateWorktree"]);
    const tools = getToolNames();

    expect(tools).toContain("AskUserQuestion");
    expect(tools).not.toContain("CreateWorktree");
  });

  test("client allowlist and explicit include cannot re-enable CreateWorktree", async () => {
    settingsManager.setIncludeWorktreeTool(false);

    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      {
        include: ["CreateWorktree"],
        clientToolAllowlist: ["AskUserQuestion", "CreateWorktree"],
      },
    );

    expect(prepared.loadedToolNames).toEqual(["AskUserQuestion"]);
  });

  test("source toolset lists keep CreateWorktree for enabled mode", () => {
    expect(ANTHROPIC_DEFAULT_TOOLS).toContain("CreateWorktree");
    expect(OPENAI_PASCAL_TOOLS).toContain("CreateWorktree");
    expect(GEMINI_PASCAL_TOOLS).toContain("CreateWorktree");
  });
});
