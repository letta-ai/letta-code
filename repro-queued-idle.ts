// Usage: bun repro-queued-idle.ts /path/to/letta-agent-sdk-0.6.3/src/remote-turn-coordinator.ts
// The turn callback is deliberately stubbed: inspect whether the client finishes before it is entered.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
} from "./src/websocket/listener/connection";
import { createListenerMessageHandler } from "./src/websocket/listener/message-router";
import type {
  IncomingMessage,
  StartListenerOptions,
} from "./src/websocket/listener/types";

const { RemoteTurnCoordinator } = await import(
  pathToFileURL(resolve(process.argv[2] ?? "")).href
);

import { getOrCreateScopedRuntime } from "./src/websocket/listener/conversation-runtime";
import { createRuntime } from "./src/websocket/listener/lifecycle";
import { setActiveRuntime } from "./src/websocket/listener/runtime";

const scope = { agent_id: "agent-repro", conversation_id: "conv-repro" };
const client = new RemoteTurnCoordinator({
  label: "repro",
  onDeviceStatus() {},
});
client.trackSentTurn(scope);
let entered = false;
const socket = {
  readyState: WebSocket.OPEN,
  send(raw: string) {
    const frame = JSON.parse(raw);
    console.log(
      "frame",
      frame.type,
      frame.loop_status ?? frame.delta?.message_type ?? "",
      "bodyEntered",
      entered,
    );
    client.handleProtocolMessage(frame, scope);
  },
};
const listener = createRuntime();
const runtime = getOrCreateScopedRuntime(
  listener,
  scope.agent_id,
  scope.conversation_id,
);
listener.socket = socket as unknown as WebSocket;
setActiveRuntime(listener);
const options: StartListenerOptions = {
  connectionId: "repro",
  wsUrl: "wss://example.test",
  deviceId: "repro",
  connectionName: "repro",
  onConnected() {},
  onDisconnected() {},
  onError() {},
};
openListenerConnection({
  runtime: listener,
  connectionId: "repro",
  writer: socket as unknown as WebSocket,
  options,
});
markListenerConnectionInitialized(listener, "repro");
subscribeListenerConnection(listener, "repro", scope);
const processTurn = async (_incoming: IncomingMessage) => {
  entered = true;
  console.log(
    "turn callback: client already finished=",
    !client.hasInFlightTurn(),
  );
};
const handler = createListenerMessageHandler({
  runtime: listener,
  socket: socket as unknown as WebSocket,
  opts: options,
  processQueuedTurn: processTurn,
  processIncomingMessage: processTurn,
  fileCommandSession: { handle: () => false },
  getParsedRuntimeScope: () => null,
  replaySyncStateForRuntime: async () => {},
  getOrCreateScopedRuntime: () => runtime,
  handleApprovalResponseInput: async () => false,
  handleChangeDeviceStateInput: async () => false,
  handleAbortMessageInput: async () => false,
  stampInboundUserMessageOtids: (incoming) => incoming,
  safeSocketSend: (_socket, frame) => {
    console.log("ack", JSON.stringify(frame));
    return true;
  },
  runDetachedListenerTask() {},
  trackListenerError(error) {
    throw error;
  },
});
await handler(
  Buffer.from(
    JSON.stringify({
      type: "input",
      request_id: "repro",
      runtime: scope,
      payload: {
        kind: "create_message",
        messages: [
          {
            role: "user",
            content: "Run three tools",
            client_message_id: "cm-repro",
          },
        ],
      },
    }),
  ),
);
await runtime.messageQueue;
client.close();
for (let i = 0; i < 12; i++) {
  const msg = await client.nextMessage();
  console.log("sdk", JSON.stringify(msg));
  if (!msg || msg.type === "result") break;
}
setActiveRuntime(null);
