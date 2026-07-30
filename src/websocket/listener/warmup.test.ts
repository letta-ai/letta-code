import { afterEach, expect, mock, test } from "bun:test";
import { createSharedReminderState } from "@/reminders/state";
import {
  clearSecretsCache,
  initSecretsFromServer,
} from "@/utils/secrets-store";
import { __listenClientTestUtils } from "@/websocket/listen-client";
import {
  __listenerWarmupTestUtils,
  ensureListenerWarmStateForTurn,
} from "./warmup";

afterEach(() => {
  __listenerWarmupTestUtils.resetWarmupDepsForTests();
  clearSecretsCache("agent-secret-refresh");
});

test("invalidates server-backed secrets before each turn hydration", async () => {
  const listener = __listenClientTestUtils.createListenerRuntime();
  const invalidateSecrets = mock(() => {});
  const ensureSecrets = mock(async () => {});

  __listenerWarmupTestUtils.setWarmupDepsForTests({
    ensureMemfsSyncedForAgent: async () => true,
    ensureSecretsHydratedForAgent: ensureSecrets,
    fetchListenerAgentMetadata: async () => ({
      name: null,
      description: null,
      lastRunAt: null,
    }),
    invalidateSecretsCacheForAgent: invalidateSecrets,
  });

  await ensureListenerWarmStateForTurn(listener, {
    agentId: "agent-secret-refresh",
    conversationId: "conversation-existing-sandbox",
  });

  expect(invalidateSecrets).toHaveBeenCalledWith(
    listener,
    "agent-secret-refresh",
  );
  expect(ensureSecrets).toHaveBeenCalledWith(listener, "agent-secret-refresh");
  expect(invalidateSecrets.mock.invocationCallOrder[0]).toBeLessThan(
    ensureSecrets.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
  );
});

test("reschedules the secrets reminder when another client changes secret names", async () => {
  const agentId = "agent-secret-refresh";
  const listener = __listenClientTestUtils.createListenerRuntime();
  const reminderState = createSharedReminderState();
  reminderState.hasSentSecretsInfo = true;
  listener.reminderStateByConversation.set(
    `agent:${agentId}::conversation:conversation-existing-sandbox`,
    reminderState,
  );
  await initSecretsFromServer(agentId, {
    secrets: [{ key: "EXISTING_SECRET", value: "first" }],
  });

  __listenerWarmupTestUtils.setWarmupDepsForTests({
    ensureMemfsSyncedForAgent: async () => true,
    ensureSecretsHydratedForAgent: async () => {
      await initSecretsFromServer(agentId, {
        secrets: [
          { key: "EXISTING_SECRET", value: "first" },
          { key: "NEW_SECRET", value: "second" },
        ],
      });
    },
    fetchListenerAgentMetadata: async () => ({
      name: null,
      description: null,
      lastRunAt: null,
    }),
    invalidateSecretsCacheForAgent: () => {},
  });

  await ensureListenerWarmStateForTurn(listener, {
    agentId,
    conversationId: "conversation-existing-sandbox",
  });

  expect(reminderState.hasSentSecretsInfo).toBe(false);
  expect(reminderState.pendingSecretsInfoRefresh).toBe(true);
});
