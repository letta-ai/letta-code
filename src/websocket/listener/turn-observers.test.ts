import { describe, expect, test } from "bun:test";
import { notifyStreamObserversRuntimeStopped } from "./stream-observers";
import {
  notifyTurnFinished,
  notifyTurnStarted,
  registerTurnObserver,
} from "./turn-observers";
import type { IncomingMessage, ListenerRuntime } from "./types";

function incoming(otids: Array<string | undefined>): IncomingMessage {
  return {
    type: "message",
    agentId: "agent-1",
    conversationId: "conv-1",
    messages: otids.map((otid) => ({
      role: "user" as const,
      content: "hi",
      ...(otid ? { otid } : {}),
    })),
  };
}

describe("turn observers", () => {
  test("notifies hooks for matching OTIDs only", () => {
    const events: string[] = [];
    const unregister = registerTurnObserver("otid-a", {
      onStarted: () => events.push("started"),
      onFinished: () => events.push("finished"),
    });

    notifyTurnStarted(incoming(["otid-other"]));
    notifyTurnFinished(incoming(["otid-other"]));
    expect(events).toEqual([]);

    notifyTurnStarted(incoming(["otid-a"]));
    notifyTurnFinished(incoming(["otid-a"]));
    expect(events).toEqual(["started", "finished"]);

    unregister();
    notifyTurnStarted(incoming(["otid-a"]));
    expect(events).toEqual(["started", "finished"]);
  });

  test("matches any OTID in a batched turn", () => {
    const events: string[] = [];
    const unregister = registerTurnObserver("otid-b", {
      onFinished: () => events.push("finished"),
    });
    notifyTurnFinished(incoming(["otid-x", "otid-b"]));
    expect(events).toEqual(["finished"]);
    unregister();
  });
});

describe("runtime-stopped stream notification", () => {
  test("notifies all observers with a terminal event and clears the set", () => {
    const seen: string[] = [];
    const listener = {
      streamObservers: new Set([
        (message: { type: string }) => seen.push(`a:${message.type}`),
        (message: { type: string }) => seen.push(`b:${message.type}`),
      ]),
    } as unknown as ListenerRuntime;

    notifyStreamObserversRuntimeStopped(listener);
    expect(seen).toEqual(["a:runtime_stopped", "b:runtime_stopped"]);
    expect(listener.streamObservers?.size).toBe(0);
  });
});
