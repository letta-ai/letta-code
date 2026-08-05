import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { __testSetBackend, type AgentCreateBody } from "@/backend";
import { LocalBackend } from "@/backend/local";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import { createRuntime } from "@/websocket/listener/lifecycle";
import { evictConversationRuntimeIfIdle } from "@/websocket/listener/runtime";
import { handleRuntimeStartCommand } from "./runtime-start";

describe("runtime_start skill sources", () => {
  afterEach(() => {
    __testSetBackend(null);
  });

  test("keeps an empty override across idle runtime eviction", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "runtime-skills-"));
    try {
      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "Skill-less SDK worker",
        model: "anthropic/claude-sonnet-4-6",
      } as AgentCreateBody);
      const listener = createRuntime();

      await handleRuntimeStartCommand(
        {
          type: "runtime_start",
          request_id: "runtime-no-skills",
          agent_id: agent.id,
          conversation_id: "default",
          skill_sources: [],
          recover_approvals: false,
        },
        {
          socket: {} as WebSocket,
          connectionId: "test-connection",
          runtime: listener,
          safeSocketSend: () => true,
          runDetachedListenerTask: () => {},
          getOrCreateScopedRuntime,
          replaySyncStateForRuntime: async () => {},
        },
      );

      const scoped = getOrCreateScopedRuntime(listener, agent.id, "default");
      expect(scoped.skillSources).toEqual([]);
      expect(listener.skillSourcesByConversation.get(scoped.key)).toEqual([]);
      expect(evictConversationRuntimeIfIdle(scoped)).toBe(true);

      const restored = getOrCreateScopedRuntime(listener, agent.id, "default");
      expect(restored).not.toBe(scoped);
      expect(restored.skillSources).toEqual([]);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("preserves skill sources when a secondary controller updates runtime tools", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "runtime-skills-"));
    try {
      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "Shared runtime worker",
        model: "anthropic/claude-sonnet-4-6",
      } as AgentCreateBody);
      const listener = createRuntime();
      const context = {
        socket: {} as WebSocket,
        connectionId: "test-connection",
        runtime: listener,
        safeSocketSend: () => true,
        runDetachedListenerTask: () => {},
        getOrCreateScopedRuntime,
        replaySyncStateForRuntime: async () => {},
      };

      await handleRuntimeStartCommand(
        {
          type: "runtime_start",
          request_id: "runtime-with-skills",
          agent_id: agent.id,
          conversation_id: "default",
          skill_sources: ["global", "project"],
          recover_approvals: false,
        },
        context,
      );
      await handleRuntimeStartCommand(
        {
          type: "runtime_start",
          request_id: "runtime-external-tools",
          agent_id: agent.id,
          conversation_id: "default",
          preserve_skill_sources: true,
          external_tools: [],
          recover_approvals: false,
        },
        context,
      );

      const scoped = getOrCreateScopedRuntime(listener, agent.id, "default");
      expect(scoped.skillSources).toEqual(["global", "project"]);
      expect(listener.skillSourcesByConversation.get(scoped.key)).toEqual([
        "global",
        "project",
      ]);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("wait_for_replay delays the response until recovery replay completes", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "runtime-replay-"));
    try {
      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "Replay synchronized worker",
        model: "anthropic/claude-sonnet-4-6",
      } as AgentCreateBody);
      const listener = createRuntime();
      const order: string[] = [];
      let finishReplay!: () => void;
      const replayBlocked = new Promise<void>((resolve) => {
        finishReplay = resolve;
      });

      const start = handleRuntimeStartCommand(
        {
          type: "runtime_start",
          request_id: "runtime-wait-for-replay",
          agent_id: agent.id,
          conversation_id: "default",
          recover_approvals: true,
          wait_for_replay: true,
        },
        {
          socket: {} as WebSocket,
          connectionId: "test-connection",
          runtime: listener,
          safeSocketSend: () => {
            order.push("response");
            return true;
          },
          runDetachedListenerTask: () => {},
          getOrCreateScopedRuntime,
          replaySyncStateForRuntime: async () => {
            order.push("replay-start");
            await replayBlocked;
            order.push("replay-end");
          },
        },
      );

      while (order.length === 0) await Bun.sleep(1);
      expect(order).toEqual(["replay-start"]);
      finishReplay();
      await start;
      expect(order).toEqual(["replay-start", "replay-end", "response"]);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
