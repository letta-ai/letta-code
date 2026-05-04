import { afterEach, describe, expect, mock, test } from "bun:test";
import { __listenClientTestUtils } from "../../websocket/listen-client";
import {
  __listenerWarmupTestUtils,
  ensureListenerWarmStateForTurn,
  type ListenerAgentMetadata,
  scheduleListenerWarmupsAfterSync,
} from "../../websocket/listener/warmup";

const memfsWarmupMock = mock(async () => {});
const secretsWarmupMock = mock(async () => {});
const fetchAgentMetadataMock = mock(
  async (): Promise<ListenerAgentMetadata> => ({
    name: "Listener Agent",
    description: "Warmup target",
    lastRunAt: "2026-05-02T06:00:00.000Z",
  }),
);

describe("listener warmup scheduling", () => {
  afterEach(() => {
    __listenerWarmupTestUtils.resetWarmupDepsForTests();
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
        new Promise<void>((resolve) => {
          resolveMemfs = resolve;
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
});
