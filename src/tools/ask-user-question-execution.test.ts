import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAskUserQuestionReceipt } from "@/ask-user-question";
import { classifyApprovals } from "@/cli/helpers/approval-classification";
import { permissionMode } from "@/permissions/mode";
import {
  clearCapturedToolExecutionContexts,
  executeTool,
  getClientToolsFromRegistry,
  getInternalToolName,
  prepareToolExecutionContextForModel,
} from "./manager";
import {
  forceToolsetSwitch,
  loadStartupTools,
  prepareToolExecutionContextForResolvedTarget,
  switchToolsetForModel,
} from "./toolset";

const questions = [
  {
    question: "Which warehouse?",
    header: "Warehouse",
    options: [
      { label: "Snowflake", description: "Read-only SQL" },
      { label: "BigQuery", description: "Read-only SQL" },
    ],
  },
];
const directories: string[] = [];

afterEach(async () => {
  clearCapturedToolExecutionContexts();
  permissionMode.reset();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("async question execution", () => {
  test("an opted-in tool call is auto-approved and returns its executor identity without a human response", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "async-question-"));
    directories.push(cwd);
    permissionMode.setMode("standard");
    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      { workingDirectory: cwd, include: ["AskUserQuestionAsync"] },
    );
    const tool = prepared.clientTools.find(
      (entry) => entry.name === "AskUserQuestion",
    );
    expect(tool).toBeDefined();
    expect(getInternalToolName("AskUserQuestion")).toBe("AskUserQuestionAsync");
    const approval = {
      toolName: "AskUserQuestion",
      toolCallId: "executor-question-1",
      toolArgs: JSON.stringify({ questions }),
    };
    const classified = await classifyApprovals([approval], {
      workingDirectory: cwd,
      toolContextId: prepared.contextId,
    });
    expect(classified.needsUserInput).toEqual([]);
    expect(classified.autoAllowed.map((entry) => entry.approval)).toEqual([
      approval,
    ]);
    const strict = await classifyApprovals([approval], {
      workingDirectory: cwd,
      toolContextId: prepared.contextId,
      permissionModeState: { mode: "strict" },
    });
    expect(strict.needsUserInput.map((entry) => entry.approval)).toEqual([
      approval,
    ]);
    const result = await executeTool(
      "AskUserQuestion",
      { questions, toolCallId: "model-cannot-choose-this" },
      {
        toolContextId: prepared.contextId,
        toolCallId: approval.toolCallId,
      },
    );
    expect(result.status).toBe("success");
    expect(parseAskUserQuestionReceipt(result.toolReturn)).toMatchObject({
      toolCallId: approval.toolCallId,
      questions,
    });
    const missingIdentity = await executeTool(
      "AskUserQuestion",
      { questions, toolCallId: "spoofed" },
      { toolContextId: prepared.contextId },
    );
    expect(missingIdentity.status).toBe("error");
    expect(parseAskUserQuestionReceipt(missingIdentity.toolReturn)).toBeNull();
  });

  test("TUI startup, model switches and preset switches omit questions without explicit includes", async () => {
    await loadStartupTools({ toolset: "default" });
    expect(getClientToolsFromRegistry().map((tool) => tool.name)).not.toContain(
      "AskUserQuestion",
    );
    await forceToolsetSwitch("letta");
    expect(getClientToolsFromRegistry().map((tool) => tool.name)).not.toContain(
      "AskUserQuestion",
    );
    await switchToolsetForModel("openai/gpt-5.6-sol", "openai");
    expect(getClientToolsFromRegistry().map((tool) => tool.name)).not.toContain(
      "AskUserQuestion",
    );
    const tui = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
    );
    expect(tui.clientTools.map((tool) => tool.name)).not.toContain(
      "AskUserQuestion",
    );
  });

  test("request-scoped inclusion leaves every default preset unchanged", async () => {
    for (const toolsetPreference of ["default", "letta", "codex"] as const) {
      const parent = await prepareToolExecutionContextForResolvedTarget({
        toolsetPreference,
        conversationId: "parent",
        clientToolset: { include: ["AskUserQuestionAsync"] },
      });
      expect(
        parent.preparedToolContext.clientTools.map((tool) => tool.name),
      ).toContain("AskUserQuestion");
      for (const conversationId of ["other-conversation", "parent"]) {
        const next = await prepareToolExecutionContextForResolvedTarget({
          toolsetPreference,
          conversationId,
        });
        expect(
          next.preparedToolContext.clientTools.map((tool) => tool.name),
        ).not.toContain("AskUserQuestion");
      }
    }
  });
});
