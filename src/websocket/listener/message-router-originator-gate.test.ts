/**
 * Pre-commit originator admission gate tests for the listener message router
 * (evil-shub round-8 P1). Split out of message-router.test.ts so both files
 * stay under the source-file size limit.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import {
  configureMcpOriginatorAuthorityPersistenceForTests,
  markMcpOriginatorTerminal,
  resetMcpOriginatorAuthority,
} from "@/agent/mcp-originator-authority";
import {
  clearMcpOriginatorTokens,
  getMcpOriginatorToken,
} from "@/agent/mcp-originator-tokens";
import { clearExternalTools } from "@/tools/manager";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { createListenerMessageHandler } from "./message-router";
import { setActiveRuntime } from "./runtime";
import { safeSocketSend } from "./socket-send";
import type { ListenerRuntime, StartListenerOptions } from "./types";

class MockSocket {
  readyState = 1; // WebSocket.OPEN
  sentPayloads: string[] = [];

  send(payload: string): void {
    this.sentPayloads.push(payload);
  }
}

function makeListenerOptions(): StartListenerOptions {
  return {
    connectionId: "conn-test",
    wsUrl: "wss://example.test/ws",
    deviceId: "device-test",
    connectionName: "listener-test",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
}

function initializeMockConnection(
  listener: ListenerRuntime,
  socket: MockSocket,
): void {
  const connection = openListenerConnection({
    runtime: listener,
    connectionId: "conn-test",
    writer: socket as unknown as WebSocket,
    options: makeListenerOptions(),
  });
  markListenerConnectionInitialized(listener, "conn-test", connection);
  subscribeListenerConnection(listener, "conn-test", {
    agent_id: "agent-1",
    conversation_id: "conv-1",
  });
}

describe("pre-commit originator admission gate (evil-shub round-8 P1)", () => {
  afterEach(() => {
    clearExternalTools();
    setActiveRuntime(null);
    clearMcpOriginatorTokens();
    configureMcpOriginatorAuthorityPersistenceForTests(null);
    resetMcpOriginatorAuthority();
  });

  function makeOriginatorInputFrame(requestId: string, runId: string): Buffer {
    return Buffer.from(
      JSON.stringify({
        type: "input",
        request_id: requestId,
        runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
        super_run_id: runId,
        mcp_originator_token: `mst_${runId}`,
        mcp_originator_generation: 1,
        payload: {
          kind: "create_message",
          messages: [{ role: "user", content: "hello" }],
        },
      }),
    );
  }

  function makeHandlerHarness(
    listener: ListenerRuntime,
    socket: MockSocket,
    onProcess: () => void,
  ) {
    const opts = makeListenerOptions();
    initializeMockConnection(listener, socket);
    setActiveRuntime(listener);
    return createListenerMessageHandler({
      runtime: listener,
      socket: socket as unknown as WebSocket,
      opts,
      processQueuedTurn: async () => {},
      fileCommandSession: { handle: () => false },
      getParsedRuntimeScope: () => null,
      replaySyncStateForRuntime: async () => {},
      getOrCreateScopedRuntime,
      handleApprovalResponseInput: async () => false,
      handleChangeDeviceStateInput: async () => false,
      handleAbortMessageInput: async () => false,
      stampInboundUserMessageOtids: (incoming) => incoming,
      safeSocketSend,
      runDetachedListenerTask: (_label, task) => {
        void task();
      },
      trackListenerError: (error) => {
        throw error;
      },
      processIncomingMessage: async () => {
        onProcess();
      },
    });
  }

  test("a retryable admission denial commits nothing and sends NO ack (redelivery retries the whole admission)", async () => {
    const root = mkdtempSync(join(tmpdir(), "letta-router-authority-"));
    try {
      const path = join(root, "authority.json");
      writeFileSync(path, "{ not json !!!");
      configureMcpOriginatorAuthorityPersistenceForTests(path);
      resetMcpOriginatorAuthority();

      const listener = createRuntime();
      const socket = new MockSocket();
      let processed = 0;
      const handleMessage = makeHandlerHarness(listener, socket, () => {
        processed += 1;
      });
      await handleMessage(makeOriginatorInputFrame("req-r8-1", "run-r8-1"));

      // No ack of any kind: the admission could not be evaluated, so Cloud
      // must treat the frame as undeliverable and redeliver it.
      expect(socket.sentPayloads).toEqual([]);
      expect(processed).toBe(0);
      expect(getMcpOriginatorToken("run-r8-1")).toBeUndefined();
      // And nothing was durably committed: the ledger has no reservation
      // for this input, so a redelivery after healing is admitted cleanly.
      writeFileSync(path, JSON.stringify({ version: 1, records: {} }));
      await handleMessage(makeOriginatorInputFrame("req-r8-1", "run-r8-1"));
      const frames = socket.sentPayloads.map(
        (p) =>
          JSON.parse(p) as {
            type?: string;
            accepted?: boolean;
          },
      );
      expect(
        frames.some((f) => f.type === "input_accepted" && f.accepted === true),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a permanently denied delivery is rejected without committing work (no redelivery loop)", async () => {
    markMcpOriginatorTerminal("run-r8-2");
    const listener = createRuntime();
    const socket = new MockSocket();
    let processed = 0;
    const handleMessage = makeHandlerHarness(listener, socket, () => {
      processed += 1;
    });
    await handleMessage(makeOriginatorInputFrame("req-r8-2", "run-r8-2"));

    const frames = socket.sentPayloads.map(
      (p) =>
        JSON.parse(p) as {
          type?: string;
          accepted?: boolean;
        },
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]?.type).toBe("input_accepted");
    expect(frames[0]?.accepted).toBe(false);
    // The non-retryable marker rides the wire so Cloud short-circuits its
    // retryable remint/retry loop instead of churning the same bytes
    // (evil-shub round-9 P2; Cloud reads it once the pairing lands).
    expect(frames[0]).toMatchObject({
      abortReason: "mcp_originator_denied_permanent",
    });
    expect(processed).toBe(0);
    expect(getMcpOriginatorToken("run-r8-2")).toBeUndefined();
  });

  test("an admitted delivery acks WITHOUT an abortReason", async () => {
    const listener = createRuntime();
    const socket = new MockSocket();
    let processed = 0;
    const handleMessage = makeHandlerHarness(listener, socket, () => {
      processed += 1;
    });
    await handleMessage(makeOriginatorInputFrame("req-r9-1", "run-r9-1"));

    const frames = socket.sentPayloads.map(
      (p) =>
        JSON.parse(p) as {
          type?: string;
          accepted?: boolean;
          abortReason?: string;
        },
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]?.accepted).toBe(true);
    expect(frames[0]?.abortReason).toBeUndefined();
    expect(processed).toBe(1);
    expect(getMcpOriginatorToken("run-r9-1")).toBe(`mst_run-r9-1`);
  });
});
