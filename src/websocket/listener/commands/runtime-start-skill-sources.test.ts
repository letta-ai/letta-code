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
});
