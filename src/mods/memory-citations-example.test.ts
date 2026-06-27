import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Letta from "@letta-ai/letta-client";
import { createModEngine } from "@/mods/mod-engine";
import { clearModPermissions } from "@/mods/permission-registry";
import { clearModTools, getModToolDefinition } from "@/mods/tool-registry";
import type {
  ModContext,
  ModConversationHandle,
  ModToolRunContext,
} from "@/mods/types";

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "letta-memory-citations-"));
}

function createContext(memoryDir: string): ModContext {
  return {
    app: { version: "test" },
    backgroundAgents: [],
    contextWindow: {
      currentUsage: null,
      remainingPercentage: null,
      size: 200000,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      usedPercentage: null,
    },
    cost: {
      totalApiDurationMs: 0,
      totalCostUsd: null,
      totalDurationMs: 0,
      totalLinesAdded: null,
      totalLinesRemoved: null,
    },
    cwd: "/tmp/project",
    lastRunId: null,
    memfs: { enabled: true, memoryDir },
    model: {
      displayName: "Sonnet",
      id: "model-1",
      provider: "anthropic",
      reasoningEffort: null,
    },
    networkPhase: null,
    permissionMode: "standard",
    reflection: { mode: null, stepCount: 0 },
    sessionId: "conversation-1",
    systemPromptId: null,
    terminalWidth: 80,
    toolset: "default",
    agent: { id: "agent-1", name: "Amelia" },
    workspace: {
      cwd: "/tmp/project",
      currentDir: "/tmp/project",
      projectDir: "/tmp/project",
    },
  };
}

function createConversation(): ModConversationHandle {
  return {
    id: "conversation-1",
    async fork() {
      return createConversation();
    },
    async getHistory() {
      return [];
    },
    async sendMessageStream() {
      return (async function* emptyStream() {})();
    },
    async updateLlmConfig() {},
  };
}

function createToolContext(memoryDir: string): ModToolRunContext {
  return {
    ...createContext(memoryDir),
    args: {},
    conversation: createConversation(),
    secret: async () => null,
    signal: new AbortController().signal,
    toolCallId: "toolu-snapshot",
  };
}

describe("memory citations example mod", () => {
  afterEach(() => {
    clearModPermissions();
    clearModTools();
  });

  test("tracks memory paths observed by tool_start and exposes a snapshot tool", async () => {
    const root = createTempDir();
    try {
      const modDir = path.join(root, "mods");
      const memoryDir = path.join(root, "memory");
      mkdirSync(modDir, { recursive: true });
      mkdirSync(path.join(memoryDir, "reference"), { recursive: true });
      copyFileSync(
        path.join(process.cwd(), "docs/examples/mods/memory-citations.ts"),
        path.join(modDir, "memory-citations.ts"),
      );

      const engine = createModEngine({
        cacheDirectory: path.join(root, "mod-cache"),
        getClient: async () => ({}) as unknown as Letta,
        globalModsDirectory: modDir,
      });
      const context = createContext(memoryDir);

      await engine.reload();
      expect(engine.getSnapshot().diagnostics).toEqual([]);
      expect(engine.getSnapshot().tools.memory_citation_snapshot).toBeDefined();

      const input = [
        {
          type: "message" as const,
          role: "user" as const,
          content: "What should I remember?",
        },
      ];
      const turnEvent = {
        agentId: "agent-1",
        conversationId: "conversation-1",
        input,
      };
      await engine.emitEvent("turn_start", turnEvent, context);
      expect(turnEvent.input).toHaveLength(2);
      expect(String(turnEvent.input[1]?.content)).toContain(
        "memory_citation_snapshot",
      );

      await engine.emitEvent(
        "tool_start",
        {
          agentId: "agent-1",
          args: { file_path: path.join(memoryDir, "reference", "harbor.md") },
          conversationId: "conversation-1",
          toolCallId: "toolu-read",
          toolName: "Read",
        },
        context,
      );
      await engine.emitEvent(
        "tool_start",
        {
          agentId: "agent-1",
          args: { command: 'cat "$MEMORY_DIR/system/collaboration.md"' },
          conversationId: "conversation-1",
          toolCallId: "toolu-bash",
          toolName: "Bash",
        },
        context,
      );
      await engine.emitEvent(
        "tool_start",
        {
          agentId: "agent-1",
          args: {
            cmd: `sed -n '1,80p' ${path.join(
              memoryDir,
              "reference",
              "learning-mods.md",
            )}`,
          },
          conversationId: "conversation-1",
          toolCallId: "toolu-exec-command",
          toolName: "exec_command",
        },
        context,
      );

      const snapshotTool = getModToolDefinition("memory_citation_snapshot");
      expect(snapshotTool).toBeDefined();
      const result = await snapshotTool?.run(createToolContext(memoryDir));
      const parsed = JSON.parse(String(result));

      expect(parsed.citationCount).toBe(3);
      expect(parsed.citations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            confidence: "high",
            path: "reference/harbor.md",
            toolName: "Read",
          }),
          expect.objectContaining({
            confidence: "medium",
            path: "system/collaboration.md",
            toolName: "Bash",
          }),
          expect.objectContaining({
            confidence: "medium",
            path: "reference/learning-mods.md",
            toolName: "exec_command",
          }),
        ]),
      );

      engine.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
