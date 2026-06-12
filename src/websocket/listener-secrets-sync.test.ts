import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type WebSocket from "ws";
import { createSharedReminderState } from "@/reminders/state";
import {
  __testOverrideSecretsBackend,
  clearSecretsCache,
  initSecretsFromServer,
  loadSecrets,
} from "@/utils/secrets-store";
import { __listenClientTestUtils } from "@/websocket/listen-client";
import { handleSecretsCommand } from "@/websocket/listener/commands/secrets";
import {
  __testOverrideRefreshSecretsForAgent,
  __testSetFreshnessMs,
  ensureSecretsHydratedForAgent,
  invalidateSecretsCacheForAgent,
} from "@/websocket/listener/secrets-sync";

const retrieveMock = mock((_agentId: string, _opts?: Record<string, unknown>) =>
  Promise.resolve({ secrets: [] as Array<{ key: string; value: string }> }),
);

describe("listener secrets sync", () => {
  beforeEach(() => {
    retrieveMock.mockReset();
    __testOverrideRefreshSecretsForAgent(async (agentId) => {
      const agent = await retrieveMock(agentId, {
        include: ["agent.secrets"],
      });
      await initSecretsFromServer(agentId, agent);
    });
    // Use a short freshness window for deterministic tests.
    __testSetFreshnessMs(500);
    clearSecretsCache("agent-listener-secret");
  });

  afterEach(() => {
    __testOverrideRefreshSecretsForAgent(null);
    __testOverrideSecretsBackend(null);
    __testSetFreshnessMs(null);
    clearSecretsCache("agent-listener-secret");
    clearSecretsCache("agent-other-secret");
  });

  test("hydrates the agent-scoped secrets cache from the server", async () => {
    retrieveMock.mockResolvedValueOnce({
      secrets: [{ key: "WS_SECRET_TOKEN", value: "listenersecret" }],
    });
    const listener = __listenClientTestUtils.createListenerRuntime();

    await ensureSecretsHydratedForAgent(listener, "agent-listener-secret");

    expect(retrieveMock).toHaveBeenCalledWith("agent-listener-secret", {
      include: ["agent.secrets"],
    });
    expect(loadSecrets("agent-listener-secret")).toEqual({
      WS_SECRET_TOKEN: "listenersecret",
    });
  });

  test("returns cached secrets within the freshness window (cache hit)", async () => {
    retrieveMock
      .mockResolvedValueOnce({
        secrets: [{ key: "WS_SECRET_TOKEN", value: "first" }],
      })
      .mockResolvedValueOnce({
        secrets: [{ key: "WS_SECRET_TOKEN", value: "second" }],
      });
    const listener = __listenClientTestUtils.createListenerRuntime();

    await ensureSecretsHydratedForAgent(listener, "agent-listener-secret");
    // Second call within the freshness window should be a cache hit.
    await ensureSecretsHydratedForAgent(listener, "agent-listener-secret");

    // Only one server fetch — the second call hit the cache.
    expect(retrieveMock).toHaveBeenCalledTimes(1);
    expect(loadSecrets("agent-listener-secret")).toEqual({
      WS_SECRET_TOKEN: "first",
    });
  });

  test("re-fetches after the freshness window expires", async () => {
    // Use a very short freshness window so it expires immediately.
    __testSetFreshnessMs(1);

    retrieveMock
      .mockResolvedValueOnce({
        secrets: [{ key: "WS_SECRET_TOKEN", value: "first" }],
      })
      .mockResolvedValueOnce({
        secrets: [{ key: "WS_SECRET_TOKEN", value: "second" }],
      });
    const listener = __listenClientTestUtils.createListenerRuntime();

    await ensureSecretsHydratedForAgent(listener, "agent-listener-secret");
    // Wait for the freshness window to expire.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await ensureSecretsHydratedForAgent(listener, "agent-listener-secret");

    expect(retrieveMock).toHaveBeenCalledTimes(2);
    expect(loadSecrets("agent-listener-secret")).toEqual({
      WS_SECRET_TOKEN: "second",
    });
  });

  test("coalesces concurrent refreshes for the same agent", async () => {
    let resolveRetrieve:
      | ((value: { secrets: Array<{ key: string; value: string }> }) => void)
      | undefined;
    retrieveMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRetrieve = resolve;
        }),
    );
    const listener = __listenClientTestUtils.createListenerRuntime();

    const first = ensureSecretsHydratedForAgent(
      listener,
      "agent-listener-secret",
    );
    const second = ensureSecretsHydratedForAgent(
      listener,
      "agent-listener-secret",
    );

    for (let i = 0; i < 10 && !resolveRetrieve; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(resolveRetrieve).toBeDefined();
    resolveRetrieve?.({
      secrets: [{ key: "WS_SECRET_TOKEN", value: "coalesced" }],
    });
    await Promise.all([first, second]);

    expect(retrieveMock).toHaveBeenCalledTimes(1);
    expect(loadSecrets("agent-listener-secret")).toEqual({
      WS_SECRET_TOKEN: "coalesced",
    });
  });

  test("invalidation during in-flight refresh forces a follow-up fetch", async () => {
    let resolveFirst:
      | ((value: { secrets: Array<{ key: string; value: string }> }) => void)
      | undefined;
    retrieveMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        secrets: [{ key: "WS_SECRET_TOKEN", value: "updated" }],
      });
    const listener = __listenClientTestUtils.createListenerRuntime();

    const first = ensureSecretsHydratedForAgent(
      listener,
      "agent-listener-secret",
    );
    for (let i = 0; i < 10 && !resolveFirst; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(resolveFirst).toBeDefined();

    invalidateSecretsCacheForAgent(listener, "agent-listener-secret");
    const second = ensureSecretsHydratedForAgent(
      listener,
      "agent-listener-secret",
    );

    resolveFirst?.({
      secrets: [{ key: "WS_SECRET_TOKEN", value: "stale" }],
    });
    await Promise.all([first, second]);

    expect(retrieveMock).toHaveBeenCalledTimes(2);
    expect(loadSecrets("agent-listener-secret")).toEqual({
      WS_SECRET_TOKEN: "updated",
    });
  });

  test("invalidation forces re-fetch even within the freshness window", async () => {
    retrieveMock
      .mockResolvedValueOnce({
        secrets: [{ key: "WS_SECRET_TOKEN", value: "first" }],
      })
      .mockResolvedValueOnce({
        secrets: [{ key: "WS_SECRET_TOKEN", value: "updated" }],
      });
    const listener = __listenClientTestUtils.createListenerRuntime();

    await ensureSecretsHydratedForAgent(listener, "agent-listener-secret");
    expect(retrieveMock).toHaveBeenCalledTimes(1);

    // Simulate a GUI secret mutation invalidating the cache.
    invalidateSecretsCacheForAgent(listener, "agent-listener-secret");

    // Next call should re-fetch even though the freshness window hasn't expired.
    await ensureSecretsHydratedForAgent(listener, "agent-listener-secret");
    expect(retrieveMock).toHaveBeenCalledTimes(2);
    expect(loadSecrets("agent-listener-secret")).toEqual({
      WS_SECRET_TOKEN: "updated",
    });
  });

  test("secret_apply schedules fresh secrets reminders for existing conversations", async () => {
    await initSecretsFromServer("agent-listener-secret", {
      secrets: [{ key: "WS_SECRET_TOKEN", value: "first" }],
    });
    const updateAgentMock = mock(() => Promise.resolve({}));
    __testOverrideSecretsBackend({
      capabilities: { serverSecrets: true },
      retrieveAgent: retrieveMock,
      updateAgent: updateAgentMock,
    });
    const listener = __listenClientTestUtils.createListenerRuntime();
    const state = createSharedReminderState();
    state.hasSentSecretsInfo = true;
    const otherAgentState = createSharedReminderState();
    otherAgentState.hasSentSecretsInfo = true;
    listener.reminderStateByConversation.set(
      "agent:agent-listener-secret::conversation:conv-a",
      state,
    );
    listener.reminderStateByConversation.set(
      "agent:agent-other-secret::conversation:conv-b",
      otherAgentState,
    );
    const sent: unknown[] = [];
    const tasks: Promise<void>[] = [];

    const handled = handleSecretsCommand(
      {
        type: "secret_apply",
        request_id: "req-secret-apply",
        agent_id: "agent-listener-secret",
        set: { WS_SECRET_TOKEN: "updated" },
        unset: [],
      },
      {
        socket: {} as WebSocket,
        runtime: listener,
        safeSocketSend: (_socket, message) => {
          sent.push(message);
          return true;
        },
        runDetachedListenerTask: (_name, task) => {
          tasks.push(task());
        },
      },
    );

    expect(handled).toBe(true);
    await Promise.all(tasks);

    expect(updateAgentMock).toHaveBeenCalledWith("agent-listener-secret", {
      secrets: { WS_SECRET_TOKEN: "updated" },
    });
    expect(listener.secretsDirtyAgents.has("agent-listener-secret")).toBe(true);
    expect(state.hasSentSecretsInfo).toBe(false);
    expect(state.pendingSecretsInfoRefresh).toBe(true);
    expect(otherAgentState.hasSentSecretsInfo).toBe(true);
    expect(otherAgentState.pendingSecretsInfoRefresh).toBe(false);
    expect(sent).toEqual([
      {
        type: "secret_apply_response",
        request_id: "req-secret-apply",
        success: true,
        names: ["WS_SECRET_TOKEN"],
      },
    ]);
  });

  test("approval reuse: same-turn call after preflight hits cache", async () => {
    retrieveMock.mockResolvedValueOnce({
      secrets: [{ key: "WS_SECRET_TOKEN", value: "preflight" }],
    });
    const listener = __listenClientTestUtils.createListenerRuntime();

    // Simulate the turn preflight hydration.
    await ensureSecretsHydratedForAgent(listener, "agent-listener-secret");

    // Simulate the approval execution path calling again in the same turn.
    await ensureSecretsHydratedForAgent(listener, "agent-listener-secret");

    // Only one server fetch — the approval path reused the cached hydration.
    expect(retrieveMock).toHaveBeenCalledTimes(1);
    expect(loadSecrets("agent-listener-secret")).toEqual({
      WS_SECRET_TOKEN: "preflight",
    });
  });

  test("invalidation clears dirty flag after successful re-fetch", async () => {
    retrieveMock
      .mockResolvedValueOnce({
        secrets: [{ key: "WS_SECRET_TOKEN", value: "first" }],
      })
      .mockResolvedValueOnce({
        secrets: [{ key: "WS_SECRET_TOKEN", value: "second" }],
      })
      .mockResolvedValueOnce({
        secrets: [{ key: "WS_SECRET_TOKEN", value: "third" }],
      });
    const listener = __listenClientTestUtils.createListenerRuntime();

    // First hydration.
    await ensureSecretsHydratedForAgent(listener, "agent-listener-secret");
    expect(retrieveMock).toHaveBeenCalledTimes(1);

    // Invalidate and re-fetch.
    invalidateSecretsCacheForAgent(listener, "agent-listener-secret");
    await ensureSecretsHydratedForAgent(listener, "agent-listener-secret");
    expect(retrieveMock).toHaveBeenCalledTimes(2);

    // After re-fetch, the dirty flag is cleared and the cache is fresh again.
    // A third call within the freshness window should be a cache hit.
    await ensureSecretsHydratedForAgent(listener, "agent-listener-secret");
    expect(retrieveMock).toHaveBeenCalledTimes(2); // no new fetch
  });
});
