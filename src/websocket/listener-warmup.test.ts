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
  type ListenerAgentMetadata,
  scheduleListenerWarmupsAfterSync,
} from "@/websocket/listener/warmup";

const memfsWarmupMock = mock(async () => true);
const secretsWarmupMock = mock(async () => {});
const fetchAgentMetadataMock = mock(
  async (): Promise<ListenerAgentMetadata> => ({
    name: "Listener Agent",
    description: "Warmup target",
    lastRunAt: "2026-05-02T06:00:00.000Z",
  }),
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
    let resolveMetadata: ((value: ListenerAgentMetadata) => void) | undefined;

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
        new Promise<ListenerAgentMetadata>((resolve) => {
          resolveMetadata = resolve;
        }),
    );
    __listenerWarmupTestUtils.setWarmupDepsForTests({
      ensureMemfsSyncedForAgent: memfsWarmupMock,
      ensureSecretsHydratedForAgent: secretsWarmupMock,
      fetchListenerAgentMetadata: fetchAgentMetadataMock,
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

    expect(memfsWarmupMock).toHaveBeenCalledTimes(2);
    expect(secretsWarmupMock).toHaveBeenCalledTimes(2);
    expect(fetchAgentMetadataMock).toHaveBeenCalledTimes(1);

    resolveMemfs?.();
    resolveSecrets?.();
    resolveMetadata?.({
      name: "Listener Agent",
      description: "Warmup target",
      lastRunAt: "2026-05-02T06:00:00.000Z",
    });

    await expect(turnWarmup).resolves.toEqual({
      name: "Listener Agent",
      description: "Warmup target",
      lastRunAt: "2026-05-02T06:00:00.000Z",
    });

    expect(memfsWarmupMock).toHaveBeenCalledTimes(2);
    expect(secretsWarmupMock).toHaveBeenCalledTimes(2);
    expect(fetchAgentMetadataMock).toHaveBeenCalledTimes(1);
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
      fetchListenerAgentMetadata: async () => ({
        name: "Warmup Agent",
        description: null,
        lastRunAt: null,
      }),
    });

    let warmup: Promise<ListenerAgentMetadata | null> | undefined;
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
