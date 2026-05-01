import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  clearSecretsCache,
  initSecretsFromServer,
  loadSecrets,
} from "../../utils/secretsStore";
import { __listenClientTestUtils } from "../../websocket/listen-client";
import {
  __testOverrideRefreshSecretsForAgent,
  ensureSecretsHydratedForAgent,
} from "../../websocket/listener/secrets-sync";

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
    clearSecretsCache("agent-listener-secret");
  });

  afterEach(() => {
    __testOverrideRefreshSecretsForAgent(null);
    clearSecretsCache("agent-listener-secret");
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

  test("does not memoize completed refreshes so GUI updates are visible", async () => {
    retrieveMock
      .mockResolvedValueOnce({
        secrets: [{ key: "WS_SECRET_TOKEN", value: "first" }],
      })
      .mockResolvedValueOnce({
        secrets: [{ key: "WS_SECRET_TOKEN", value: "second" }],
      });
    const listener = __listenClientTestUtils.createListenerRuntime();

    await ensureSecretsHydratedForAgent(listener, "agent-listener-secret");
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
});
