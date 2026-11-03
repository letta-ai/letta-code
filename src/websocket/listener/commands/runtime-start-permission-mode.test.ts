import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { __testSetBackend, type AgentCreateBody } from "@/backend";
import { LocalBackend } from "@/backend/local";
import type { RuntimeStartCommand } from "@/types/runtime-start-protocol";
import { handleModeChange } from "@/websocket/listener/control-inputs";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import { createRuntime } from "@/websocket/listener/lifecycle";
import { getConversationPermissionModeState } from "@/websocket/listener/permission-mode";
import { resetRemoteSettingsCache } from "@/websocket/listener/remote-settings";
import type { ListenerRuntime } from "@/websocket/listener/types";
import { handleRuntimeStartCommand } from "./runtime-start";

const socket = { readyState: 3, send: () => {} } as unknown as WebSocket;

function runtimeStart(
  listener: ListenerRuntime,
  command: Omit<RuntimeStartCommand, "type" | "request_id">,
) {
  return handleRuntimeStartCommand(
    {
      type: "runtime_start",
      request_id: `runtime-start-${Math.random()}`,
      recover_approvals: false,
      ...command,
    },
    {
      socket,
      connectionId: "test-connection",
      runtime: listener,
      safeSocketSend: () => true,
      runDetachedListenerTask: () => {},
      getOrCreateScopedRuntime,
      replaySyncStateForRuntime: async () => {},
    },
  );
}

describe("runtime_start default permission mode", () => {
  let storageDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "runtime-mode-"));
    previousConfigDir = process.env.LETTA_CONFIG_DIR;
    process.env.LETTA_CONFIG_DIR = join(storageDir, "config");
    resetRemoteSettingsCache();
    __testSetBackend(
      new LocalBackend({ storageDir, executionMode: "deterministic" }),
    );
  });

  afterEach(async () => {
    __testSetBackend(null);
    if (previousConfigDir === undefined) delete process.env.LETTA_CONFIG_DIR;
    else process.env.LETTA_CONFIG_DIR = previousConfigDir;
    resetRemoteSettingsCache();
    await rm(storageDir, { recursive: true, force: true });
  });

  async function createAgentId(): Promise<string> {
    const { getBackend } = await import("@/backend");
    const agent = await getBackend().createAgent({
      name: "Channel mode worker",
      model: "anthropic/claude-sonnet-4-6",
    } as AgentCreateBody);
    return agent.id;
  }

  test("keeps an explicit unrestricted mode across listener restart and channel re-registration", async () => {
    const agentId = await createAgentId();
    const first = createRuntime();
    handleModeChange({ mode: "unrestricted" }, socket, first, {
      agent_id: agentId,
      conversation_id: "default",
    });

    // Simulate a listener restart: the new runtime loads the persisted map.
    const restarted = createRuntime();
    await runtimeStart(restarted, {
      agent_id: agentId,
      conversation_id: "default",
      mode: "standard",
      mode_is_default: true,
    });

    expect(
      getConversationPermissionModeState(restarted, agentId, "default").mode,
    ).toBe("unrestricted");
  });

  test("applies the channel default to a conversation without an explicit mode", async () => {
    const agentId = await createAgentId();
    const listener = createRuntime();
    await runtimeStart(listener, {
      agent_id: agentId,
      conversation_id: "default",
      mode: "standard",
      mode_is_default: true,
    });

    expect(
      getConversationPermissionModeState(listener, agentId, "default").mode,
    ).toBe("standard");
  });
});
