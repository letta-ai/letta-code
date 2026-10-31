import { expect, test } from "bun:test";
import { runWithRuntimeContext } from "@/runtime-context";
import {
  addToMessageQueue,
  clearPendingMessages,
} from "@/utils/message-queue-bridge";
import { resolveNotificationScope } from "@/utils/task-notifications";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import {
  clearProcessServices,
  installProcessEventRouting,
} from "./process-services";
import { buildLoopStatus } from "./protocol-outbound";
import { setActiveRuntime } from "./runtime";
import { LocalListenerTransport } from "./transport";
import { createTurnCorrelation } from "./turn-correlation";

test("a background notification turn is correlated with the send that started the work", async () => {
  const listener = createRuntime();
  setActiveRuntime(listener);
  const runtime = getOrCreateScopedRuntime(listener, "agent-bg", "conv-bg");
  let notificationTurnRan = false;
  installProcessEventRouting({
    runtime: listener,
    processTransport: new LocalListenerTransport(),
    opts: {
      connectionId: "bg-connection",
      wsUrl: "ws://test",
      deviceId: "device-bg",
      connectionName: "test",
      onConnected() {},
      onDisconnected() {},
      onError() {},
    },
    processQueuedTurn: async (incoming, batch) => {
      if (incoming.conversationId !== "conv-bg") return;
      createTurnCorrelation(runtime, incoming, batch.batchId).observeRun(
        "run-notification",
      );
      notificationTurnRan = true;
    },
  });

  try {
    // The send's turn starts background work, which captures its scope.
    const sendTurn = createTurnCorrelation(
      runtime,
      {
        type: "message",
        agentId: "agent-bg",
        conversationId: "conv-bg",
        messages: [{ role: "user", content: "go", client_message_id: "cm-x" }],
      },
      "batch-send",
    );
    sendTurn.observeRun("run-send");
    const scope = runWithRuntimeContext(
      { resolveClientMessageIds: () => sendTurn.clientMessageIds },
      () =>
        resolveNotificationScope({
          agentId: "agent-bg",
          conversationId: "conv-bg",
        }),
    );

    // Later, the work completes and reports back through the queue bridge.
    addToMessageQueue({
      kind: "task_notification",
      text: "<task-notification>done</task-notification>",
      ...scope,
    });
    const deadline = Date.now() + 5_000;
    while (!notificationTurnRan && Date.now() < deadline) await Bun.sleep(10);
    expect(notificationTurnRan).toBe(true);

    expect(buildLoopStatus(runtime).client_message_ids_by_run_id).toEqual({
      "run-send": ["cm-x"],
      "run-notification": ["cm-x"],
    });
  } finally {
    clearProcessServices(listener);
    clearPendingMessages();
    setActiveRuntime(null);
  }
}, 10_000);
