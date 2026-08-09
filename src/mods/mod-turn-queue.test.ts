import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Letta from "@letta-ai/letta-client";
import { clearRegisteredPiProviders } from "@/backend/dev/pi-provider-mod-registry";
import { createModEngine } from "@/mods/mod-engine";
import { clearModPermissions } from "@/mods/permission-registry";
import { clearModTools } from "@/mods/tool-registry";
import type { ModContext, ModTurnStartEvent } from "@/mods/types";

function createModContext(): ModContext {
  return {
    app: { version: "test" },
    backgroundAgents: [],
    subagents: { list: () => [] },
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
    memfs: { enabled: false, memoryDir: null },
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
    conversationSummary: null,
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

describe("mod turn queue", () => {
  afterEach(() => {
    clearModPermissions();
    clearModTools();
    clearRegisteredPiProviders();
  });

  test("composes validated passive context and rolls back handler errors", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "letta-mod-turn-queue-"));
    try {
      const modDir = path.join(root, "global-mods");
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        path.join(modDir, "turn-queue.ts"),
        `export default function(letta) {
          letta.events.on("turn_start", (event) => ({
            queueItems: [
              ...event.queueItems,
              { kind: "context", content: "first" },
            ],
          }));
          letta.events.on("turn_start", (event) => {
            event.queueItems.push({ kind: "context", content: "broken" });
            throw new Error("turn_start failed");
          });
          letta.events.on("turn_start", (event) => ({
            queueItems: [
              ...event.queueItems,
              { kind: "context", content: "second" },
            ],
          }));
        }`,
      );

      const engine = createModEngine({
        cacheDirectory: path.join(root, "mod-cache"),
        getClient: async () => ({}) as unknown as Letta,
        globalModsDirectory: modDir,
      });
      await engine.reload();
      const event: ModTurnStartEvent = {
        agentId: "agent-1",
        conversationId: "conversation-1",
        input: [{ role: "user", content: "hello" }],
        queueItems: [],
      };

      const result = await engine.emitEvent(
        "turn_start",
        event,
        createModContext(),
      );

      expect(result.diagnostics).toHaveLength(1);
      expect(event.queueItems).toEqual([
        { kind: "context", content: "first" },
        { kind: "context", content: "second" },
      ]);
      engine.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
