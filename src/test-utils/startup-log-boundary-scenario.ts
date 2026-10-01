import "@/utils/startup-log-boundary";
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import WebSocket from "ws";
import { openListenerConnection } from "@/websocket/listener/connection";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import {
  createRuntime,
  startConnectedListenerRuntime,
  stopRuntime,
} from "@/websocket/listener/lifecycle";
import { createListenerMessageHandler } from "@/websocket/listener/message-router";
import { setActiveRuntime } from "@/websocket/listener/runtime";
import type { StartListenerOptions } from "@/websocket/listener/types";

// Run in a fresh process: neither the marker singleton nor module mocks leak.
const mode = process.argv[2];
const listener = createRuntime();
const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
const log = (value: string) => writeSync(2, `${value}\n`);
const socket = {
  readyState: WebSocket.OPEN,
  bufferedAmount: 0,
  send: (data: string) => log(`SENT:${data}`),
  removeAllListeners: () => {},
  close: () => {},
} as unknown as WebSocket;
let connected = 0;
let parsed = 0;
let processed = 0;
const opts: StartListenerOptions = {
  connectionId: "startup-test",
  wsUrl: "ws://localhost/unused",
  deviceId: "device-test",
  connectionName: "startup-test",
  onConnected: () => {
    connected += 1;
    log("CONNECTED_PRIVATE");
    // A gateway can synchronously receive input inside onConnected.
    void handleMessage(input);
  },
  onDisconnected: () => {},
  onError: (error) => {
    throw error;
  },
  onLog: log,
};
listener.onWsEvent = (direction, source, payload) =>
  log(`EVENT:${direction}:${source}:${JSON.stringify(payload)}`);
listener.processServicesStarted = true;
setActiveRuntime(listener);
openListenerConnection({
  runtime: listener,
  connectionId: opts.connectionId,
  writer: socket,
  options: opts,
});
const handleMessage = createListenerMessageHandler({
  runtime: listener,
  socket,
  opts,
  processQueuedTurn: async () => {},
  fileCommandSession: { handle: () => false },
  getParsedRuntimeScope: () => {
    parsed += 1;
    return null;
  },
  replaySyncStateForRuntime: async () => {},
  getOrCreateScopedRuntime: () => runtime,
  handleApprovalResponseInput: async () => false,
  handleChangeDeviceStateInput: async () => false,
  handleAbortMessageInput: async () => false,
  stampInboundUserMessageOtids: (incoming) => incoming,
  safeSocketSend: (_socket, payload) => {
    log(`SENT:${JSON.stringify(payload)}`);
    return true;
  },
  runDetachedListenerTask: () => {},
  trackListenerError: (type) => {
    throw new Error(type);
  },
  processIncomingMessage: async () => {
    processed += 1;
    log("PROCESSED_PRIVATE");
  },
});
const input = Buffer.from(
  JSON.stringify({
    type: "input",
    request_id: "early-input",
    runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
    payload: {
      kind: "create_message",
      messages: [
        {
          role: "user",
          content: "EARLY_USER_PRIVATE",
          client_message_id: "early-1",
        },
      ],
    },
  }),
);
function connect() {
  return startConnectedListenerRuntime(listener, socket, opts, async () => {}, {
    startHeartbeat: false,
    startCronScheduler: false,
    startProcessServices: false,
    emitInitialState: false,
  });
}

try {
  assert.equal(process.env.LETTA_STARTUP_LOG_MARKER, undefined);
  assert.equal(process.env.LETTA_STARTUP_LOG_OWNER_PID, undefined);
  log("STARTUP_DIAGNOSTIC");
  if (mode === "failure" || mode === "invalid-owner") {
    await assert.rejects(handleMessage(input), /Failed to seal startup logs/);
    await assert.rejects(connect(), /Failed to seal startup logs/);
    await assert.rejects(handleMessage(input), /Failed to seal startup logs/);
    assert.equal(connected, 0);
    assert.equal(parsed, 0);
    assert.equal(processed, 0);
    log("BLOCKED_ALL_CONTENT");
  } else if (mode === "connected") {
    const first = connect();
    log("CALLER_RETURNED");
    await first;
    await connect();
    await runtime.messageQueue;
    assert.equal(connected, 2);
    assert.ok(parsed > 0);
    log("DONE");
  } else if (mode === "ready") {
    await handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "listener_ready",
          connection_generation: "test",
          connection_attempt: 1,
          extra: "READY_EXTRA_PRIVATE",
        }),
      ),
    );
    assert.equal(connected, 0);
    log("BEFORE_CONNECTED");
    await connect();
    log("DONE");
  } else {
    await handleMessage(Buffer.from('{"type":"pong"}'));
    assert.ok(listener.lastPongAt && listener.lastPongAt > 0);
    log("AFTER_PONG_STARTUP");
    // Deliver the first frame before the connected runtime has ever started.
    await handleMessage(
      mode === "malformed" ? Buffer.from("MALFORMED_PRIVATE") : input,
    );
    assert.equal(connected, 0);
    log("BEFORE_CONNECTED");
    await connect();
    await runtime.messageQueue;
    assert.ok(parsed > 0);
    log("DONE");
  }
} finally {
  stopRuntime(listener, true);
  setActiveRuntime(null);
}
// Listener dependencies can own timers; all assertions above have completed.
process.exit(0);
