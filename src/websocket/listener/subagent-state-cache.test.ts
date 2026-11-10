import { afterEach, expect, setSystemTime, test } from "bun:test";
import WebSocket from "ws";
import {
  addToolCall,
  clearAllSubagents,
  registerSubagent,
} from "@/agent/subagent-state";
import {
  getOrCreateProcessTransport,
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import {
  clearProcessServices,
  installProcessEventRouting,
} from "./process-services";
import { emitStateSync } from "./protocol-outbound";
import { setActiveRuntime } from "./runtime";
import type { StartListenerOptions } from "./types";

type SentFrame = {
  type?: string;
  runtime?: { agent_id?: string; conversation_id?: string };
  subagents?: { subagent_id: string }[];
};

const AGENT_ID = "agent-a";
const CONVERSATION_IDS = ["conv-owner", "conv-other-1", "conv-other-2"];

afterEach(() => {
  setSystemTime();
  setActiveRuntime(null);
  clearAllSubagents();
});

function setupListener() {
  const listener = createRuntime();
  setActiveRuntime(listener);
  const sent: SentFrame[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (text: string) => sent.push(JSON.parse(text)),
  } as unknown as WebSocket;
  const opts: StartListenerOptions = {
    connectionId: "connection-a",
    wsUrl: "wss://example.test/ws",
    deviceId: "device-a",
    connectionName: "test",
    onConnected() {},
    onDisconnected() {},
    onError() {},
  };
  const connection = openListenerConnection({
    runtime: listener,
    connectionId: opts.connectionId,
    writer: socket,
    options: opts,
  });
  markListenerConnectionInitialized(listener, opts.connectionId, connection);
  for (const conversationId of CONVERSATION_IDS) {
    getOrCreateScopedRuntime(listener, AGENT_ID, conversationId);
    subscribeListenerConnection(listener, opts.connectionId, {
      agent_id: AGENT_ID,
      conversation_id: conversationId,
    });
  }
  installProcessEventRouting({
    runtime: listener,
    processTransport: getOrCreateProcessTransport(listener),
    opts,
    processQueuedTurn: async () => {},
  });
  const takeSubagentUpdates = () => {
    const updates = sent.filter((f) => f.type === "update_subagent_state");
    sent.length = 0;
    return updates;
  };
  const setOpen = (open: boolean) => {
    (socket as { readyState: number }).readyState = open
      ? WebSocket.OPEN
      : WebSocket.CLOSED;
  };
  return { listener, socket, setOpen, takeSubagentUpdates };
}

test("subagent changes only emit state to conversations whose snapshot changed", () => {
  const { listener, takeSubagentUpdates } = setupListener();
  try {
    registerSubagent(
      "subagent-1",
      "general-purpose",
      "Child task",
      "tool-call-1",
      true,
      false,
      { agentId: AGENT_ID, conversationId: "conv-owner" },
    );
    const first = takeSubagentUpdates();
    expect(first.map((f) => f.runtime?.conversation_id)).toEqual([
      "conv-owner",
    ]);
    expect(first[0]?.subagents?.map((s) => s.subagent_id)).toEqual([
      "subagent-1",
    ]);

    addToolCall("subagent-1", "child-tool-1", "Read", "{}");
    expect(
      takeSubagentUpdates().map((f) => f.runtime?.conversation_id),
    ).toEqual(["conv-owner"]);

    // Store change that leaves every scoped snapshot unchanged: a silent
    // foreground subagent is filtered out of all snapshots.
    registerSubagent(
      "subagent-silent",
      "reflection",
      "Silent child",
      undefined,
      false,
      true,
      { agentId: AGENT_ID, conversationId: "conv-other-1" },
    );
    expect(takeSubagentUpdates()).toEqual([]);

    // The owning conversation gets one final empty snapshot on removal.
    clearAllSubagents();
    const cleared = takeSubagentUpdates();
    expect(cleared.map((f) => f.runtime?.conversation_id)).toEqual([
      "conv-owner",
    ]);
    expect(cleared[0]?.subagents).toEqual([]);
  } finally {
    clearProcessServices(listener);
  }
});

test("explicit state syncs always emit subagent state", () => {
  const { listener, socket, takeSubagentUpdates } = setupListener();
  try {
    registerSubagent(
      "subagent-1",
      "general-purpose",
      "Child task",
      "tool-call-1",
      true,
      false,
      { agentId: AGENT_ID, conversationId: "conv-owner" },
    );
    takeSubagentUpdates();

    for (const conversationId of CONVERSATION_IDS) {
      emitStateSync(socket, listener, {
        agent_id: AGENT_ID,
        conversation_id: conversationId,
      });
    }
    const synced = takeSubagentUpdates();
    expect(synced.map((f) => f.runtime?.conversation_id)).toEqual(
      CONVERSATION_IDS,
    );
    expect(synced[0]?.subagents?.map((s) => s.subagent_id)).toEqual([
      "subagent-1",
    ]);
  } finally {
    clearProcessServices(listener);
  }
});

test("changes missed while disconnected do not suppress updates after reconnect", () => {
  // Fixed clock so re-registering yields a byte-identical snapshot.
  setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const { listener, socket, setOpen, takeSubagentUpdates } = setupListener();
  const ownerScope = { agent_id: AGENT_ID, conversation_id: "conv-owner" };
  const registerChild = () =>
    registerSubagent(
      "subagent-1",
      "general-purpose",
      "Child task",
      "tool-call-1",
      true,
      false,
      { agentId: AGENT_ID, conversationId: "conv-owner" },
    );
  try {
    registerChild();
    expect(takeSubagentUpdates()).toHaveLength(1);

    // The subagent goes away while no connection can receive it.
    setOpen(false);
    clearAllSubagents();
    setOpen(true);
    emitStateSync(socket, listener, ownerScope);
    expect(takeSubagentUpdates()[0]?.subagents).toEqual([]);

    // Same snapshot as before the disconnect, but the client now holds [].
    registerChild();
    const updates = takeSubagentUpdates();
    expect(updates.map((f) => f.runtime?.conversation_id)).toEqual([
      "conv-owner",
    ]);
    expect(updates[0]?.subagents?.map((s) => s.subagent_id)).toEqual([
      "subagent-1",
    ]);
  } finally {
    clearProcessServices(listener);
  }
});
