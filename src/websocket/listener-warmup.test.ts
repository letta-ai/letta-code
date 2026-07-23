import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { __listenClientTestUtils } from "@/websocket/listen-client";
import { replaySyncStateForRuntime } from "@/websocket/listener/lifecycle";
import {
  __listenerModAdapterTestUtils,
  disposeListenerModAdapter,
} from "@/websocket/listener/mod-adapter";
import type { ListenerTransport } from "@/websocket/listener/transport";
import {
  __listenerWarmupTestUtils,
  ensureListenerWarmStateForTurn,
  getListenerAgentStateForTurn,
  invalidateListenerAgentWarmState,
  type ListenerAgentWarmState,
  scheduleListenerWarmupsAfterSync,
  setListenerAgentWarmState,
} from "@/websocket/listener/warmup";

function makeWarmState(
  overrides: Partial<ListenerAgentWarmState> = {},
): ListenerAgentWarmState {
  const name = overrides.name ?? "Listener Agent";
  return {
    name,
    description: "Warmup target",
    lastRunAt: "2026-05-02T06:00:00.000Z",
    agent: {
      id: "agent-1",
      name,
      tags: ["origin:letta-code"],
    } as unknown as ListenerAgentWarmState["agent"],
    ...overrides,
  };
}

const memfsWarmupMock = mock(async () => true);
const secretsWarmupMock = mock(async () => {});
const fetchAgentMetadataMock = mock(
  async (): Promise<ListenerAgentWarmState> => makeWarmState(),
);

describe("listener warmup scheduling", () => {
  beforeEach(() => {
    __listenerModAdapterTestUtils.setEnsureMemfsSyncedForAgentForTests(
      async () => true,
    );
  });

  afterEach(() => {
    __listenerWarmupTestUtils.resetWarmupDepsForTests();
    __listenerModAdapterTestUtils.resetForTests();
    memfsWarmupMock.mockReset();
    secretsWarmupMock.mockReset();
    fetchAgentMetadataMock.mockReset();
  });

  test("sync warmup joins the first turn without duplicating agent metadata fetches", async () => {
    let resolveMemfs: (() => void) | undefined;
    let resolveSecrets: (() => void) | undefined;
    let resolveMetadata: ((value: ListenerAgentWarmState) => void) | undefined;

    memfsWarmupMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveMemfs = () => resolve(true);
        }),
    );
    secretsWarmupMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSecrets = resolve;
        }),
    );
    fetchAgentMetadataMock.mockImplementationOnce(
      () =>
        new Promise<ListenerAgentWarmState>((resolve) => {
          resolveMetadata = resolve;
        }),
    );
    __listenerWarmupTestUtils.setWarmupDepsForTests({
      ensureMemfsSyncedForAgent: memfsWarmupMock,
      ensureSecretsHydratedForAgent: secretsWarmupMock,
      fetchListenerAgentWarmState: fetchAgentMetadataMock,
    });

    const listener = __listenClientTestUtils.createListenerRuntime();

    scheduleListenerWarmupsAfterSync(listener, {
      agent_id: "agent-1",
      conversation_id: "default",
    });

    const turnWarmup = ensureListenerWarmStateForTurn(listener, {
      agentId: "agent-1",
      conversationId: "default",
    });

    // Secrets hydration starts immediately; memfs waits for the shared agent
    // fetch so it can reuse the fetched (tags-included) agent state.
    expect(memfsWarmupMock).toHaveBeenCalledTimes(0);
    expect(secretsWarmupMock).toHaveBeenCalledTimes(2);
    expect(fetchAgentMetadataMock).toHaveBeenCalledTimes(1);

    const warmState = makeWarmState();
    resolveMetadata?.(warmState);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(memfsWarmupMock).toHaveBeenCalledTimes(2);
    expect((memfsWarmupMock.mock.calls[0] as unknown[])?.[2]).toBe(
      warmState.agent,
    );

    resolveMemfs?.();
    resolveSecrets?.();

    await expect(turnWarmup).resolves.toEqual(warmState);

    expect(memfsWarmupMock).toHaveBeenCalledTimes(2);
    expect(secretsWarmupMock).toHaveBeenCalledTimes(2);
    expect(fetchAgentMetadataMock).toHaveBeenCalledTimes(1);
  });

  test("turn agent state serves the warm cache and refreshes in the background", async () => {
    fetchAgentMetadataMock.mockImplementation(async () => makeWarmState());
    __listenerWarmupTestUtils.setWarmupDepsForTests({
      ensureMemfsSyncedForAgent: memfsWarmupMock,
      ensureSecretsHydratedForAgent: secretsWarmupMock,
      fetchListenerAgentWarmState: fetchAgentMetadataMock,
    });
    const listener = __listenClientTestUtils.createListenerRuntime();

    await ensureListenerWarmStateForTurn(listener, {
      agentId: "agent-1",
      conversationId: "default",
    });
    expect(fetchAgentMetadataMock).toHaveBeenCalledTimes(1);

    // Cache hit: the turn gets the cached agent without a blocking fetch, and
    // one background refresh is scheduled.
    const refreshed = makeWarmState({ name: "Renamed Agent" });
    fetchAgentMetadataMock.mockResolvedValueOnce(refreshed);
    const agent = await getListenerAgentStateForTurn(listener, "agent-1");
    expect(agent?.name).toBe("Listener Agent");

    // Let the background refresh settle; the next turn sees the fresh state.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchAgentMetadataMock).toHaveBeenCalledTimes(2);
    const nextAgent = await getListenerAgentStateForTurn(listener, "agent-1");
    expect(nextAgent?.name).toBe("Renamed Agent");
  });

  test("invalidation forces the next turn to refetch agent state", async () => {
    fetchAgentMetadataMock.mockImplementation(async () => makeWarmState());
    __listenerWarmupTestUtils.setWarmupDepsForTests({
      ensureMemfsSyncedForAgent: memfsWarmupMock,
      ensureSecretsHydratedForAgent: secretsWarmupMock,
      fetchListenerAgentWarmState: fetchAgentMetadataMock,
    });
    const listener = __listenClientTestUtils.createListenerRuntime();

    await ensureListenerWarmStateForTurn(listener, {
      agentId: "agent-1",
      conversationId: "default",
    });
    expect(fetchAgentMetadataMock).toHaveBeenCalledTimes(1);

    invalidateListenerAgentWarmState(listener, "agent-1");
    fetchAgentMetadataMock.mockResolvedValueOnce(
      makeWarmState({ name: "Post Update Agent" }),
    );
    const agent = await getListenerAgentStateForTurn(listener, "agent-1");
    expect(agent?.name).toBe("Post Update Agent");
    expect(fetchAgentMetadataMock).toHaveBeenCalledTimes(2);
  });

  test("setListenerAgentWarmState replaces the cache after local mutations", async () => {
    fetchAgentMetadataMock.mockImplementation(async () => makeWarmState());
    __listenerWarmupTestUtils.setWarmupDepsForTests({
      ensureMemfsSyncedForAgent: memfsWarmupMock,
      ensureSecretsHydratedForAgent: secretsWarmupMock,
      fetchListenerAgentWarmState: fetchAgentMetadataMock,
    });
    const listener = __listenClientTestUtils.createListenerRuntime();

    const tagged = makeWarmState({ name: "Tagged Agent" }).agent as NonNullable<
      ListenerAgentWarmState["agent"]
    >;
    setListenerAgentWarmState(listener, tagged);

    // ensure... does not schedule a refresh, so the seeded state is stable.
    const warmState = await ensureListenerWarmStateForTurn(listener, {
      agentId: "agent-1",
      conversationId: "default",
    });
    expect(warmState?.name).toBe("Tagged Agent");
    expect(fetchAgentMetadataMock).toHaveBeenCalledTimes(0);

    const agent = await getListenerAgentStateForTurn(listener, "agent-1");
    expect(agent?.name).toBe("Tagged Agent");
  });

  test("advertises scoped mod commands after background warmup", async () => {
    const root = mkdtempSync(join(tmpdir(), "letta-listener-warmup-mod-"));
    const modsDirectory = join(root, "agent-memory", "mods");
    mkdirSync(modsDirectory, { recursive: true });
    writeFileSync(
      join(modsDirectory, "warmup-command.js"),
      `export default function activate(letta) {
        letta.commands.register({
          id: "warmup-command",
          description: "Loaded after sync replay",
          run() { return "ready"; },
        });
      }`,
    );

    const sentPayloads: string[] = [];
    const transport: ListenerTransport = {
      kind: "local",
      bufferedAmount: 0,
      isOpen: () => true,
      send: (payload: string) => sentPayloads.push(payload),
    };
    const listener = __listenClientTestUtils.createListenerRuntime();
    listener.transport = transport;
    __listenerModAdapterTestUtils.setAgentModsDirectoryResolverForTests(
      () => modsDirectory,
    );
    __listenerModAdapterTestUtils.setAgentModCacheDirectoryResolverForTests(
      () => join(root, "listener-cache"),
    );
    __listenerModAdapterTestUtils.setEnsureMemfsSyncedForAgentForTests(
      async () => true,
    );
    __listenerWarmupTestUtils.setWarmupDepsForTests({
      ensureMemfsSyncedForAgent: async () => true,
      ensureSecretsHydratedForAgent: async () => {},
      fetchListenerAgentWarmState: async () =>
        makeWarmState({ name: "Warmup Agent", description: null }),
    });

    let warmup: Promise<ListenerAgentWarmState | null> | undefined;
    try {
      await replaySyncStateForRuntime(
        listener,
        transport as unknown as WebSocket,
        { agent_id: "agent-warmup", conversation_id: "default" },
        {
          recoverApprovals: false,
          scheduleWarmupsAfterSync: (runtime, scope) => {
            warmup = ensureListenerWarmStateForTurn(runtime, {
              agentId: scope.agent_id,
              conversationId: scope.conversation_id,
            });
          },
        },
      );
      await warmup;

      const deviceStatuses = sentPayloads
        .map((payload) => JSON.parse(payload))
        .filter((message) => message.type === "update_device_status");
      expect(deviceStatuses).toHaveLength(2);
      expect(deviceStatuses[0]?.device_status.mod_commands).toBeUndefined();
      expect(deviceStatuses[1]).toMatchObject({
        runtime: {
          agent_id: "agent-warmup",
          conversation_id: "default",
        },
        device_status: {
          mod_commands: [
            {
              id: "warmup-command",
              description: "Loaded after sync replay",
            },
          ],
        },
      });

      await ensureListenerWarmStateForTurn(listener, {
        agentId: "agent-warmup",
        conversationId: "default",
      });
      expect(
        sentPayloads
          .map((payload) => JSON.parse(payload))
          .filter((message) => message.type === "update_device_status"),
      ).toHaveLength(2);
    } finally {
      disposeListenerModAdapter(listener);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
