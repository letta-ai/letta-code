import { describe, expect, mock, test } from "bun:test";

const memfsWarmupMock = mock(async () => {});
const secretsWarmupMock = mock(async () => {});
const agentRetrieveMock = mock(async () => ({
  name: "Listener Agent",
  description: "Warmup target",
  last_run_completion: "2026-05-02T06:00:00.000Z",
}));

mock.module("../../websocket/listener/memfs-sync", () => ({
  ensureMemfsSyncedForAgent: memfsWarmupMock,
}));

mock.module("../../websocket/listener/secrets-sync", () => ({
  ensureSecretsHydratedForAgent: secretsWarmupMock,
}));

mock.module("../../backend/api/client", () => ({
  getClient: mock(async () => ({
    agents: {
      retrieve: agentRetrieveMock,
    },
  })),
}));

const { __listenClientTestUtils } = await import(
  "../../websocket/listen-client"
);
const { ensureListenerWarmStateForTurn, scheduleListenerWarmupsAfterSync } =
  await import("../../websocket/listener/warmup");

describe("listener warmup scheduling", () => {
  test("sync warmup joins the first turn without duplicating fetches", async () => {
    let resolveMemfs: (() => void) | undefined;
    let resolveSecrets: (() => void) | undefined;
    let resolveRetrieve:
      | ((value: {
          name: string;
          description: string;
          last_run_completion: string;
        }) => void)
      | undefined;

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
    agentRetrieveMock.mockImplementationOnce(
      () =>
        new Promise<{
          name: string;
          description: string;
          last_run_completion: string;
        }>((resolve) => {
          resolveRetrieve = resolve;
        }),
    );

    const listener = __listenClientTestUtils.createListenerRuntime();

    scheduleListenerWarmupsAfterSync(listener, {
      agent_id: "agent-1",
      conversation_id: "default",
    });

    const turnWarmup = ensureListenerWarmStateForTurn(listener, {
      agentId: "agent-1",
      conversationId: "default",
    });

    expect(memfsWarmupMock).toHaveBeenCalledTimes(1);
    expect(secretsWarmupMock).toHaveBeenCalledTimes(1);
    expect(agentRetrieveMock).toHaveBeenCalledTimes(1);

    resolveMemfs?.();
    resolveSecrets?.();
    resolveRetrieve?.({
      name: "Listener Agent",
      description: "Warmup target",
      last_run_completion: "2026-05-02T06:00:00.000Z",
    });

    await expect(turnWarmup).resolves.toEqual({
      name: "Listener Agent",
      description: "Warmup target",
      lastRunAt: "2026-05-02T06:00:00.000Z",
    });

    expect(memfsWarmupMock).toHaveBeenCalledTimes(1);
    expect(secretsWarmupMock).toHaveBeenCalledTimes(1);
    expect(agentRetrieveMock).toHaveBeenCalledTimes(1);
  });
});
