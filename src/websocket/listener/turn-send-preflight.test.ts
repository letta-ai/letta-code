import { expect, spyOn, test } from "bun:test";
import * as message from "@/agent/message";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import * as send from "./send";
import { startTurnInput } from "./turn-send";

// The recovery seam is shared with 409 recovery. Hold it open to verify that
// delivery cannot race the unresolved boundary or submit the user input first.
test("queued delivery waits for existing stale-approval recovery before sending", async () => {
  const runtime = getOrCreateScopedRuntime(
    createRuntime(),
    "agent-1",
    "conv-1",
  );
  runtime.queuePumpActive = true;
  const turnLease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  const events: string[] = [];
  let release!: () => void;
  const boundary = new Promise<void>((resolve) => {
    release = resolve;
  });
  const recover = spyOn(send, "resolveStaleApprovals").mockImplementation(
    async () => {
      events.push("recovery");
      await boundary;
      events.push("resolved");
      return null;
    },
  );
  const submit = spyOn(message, "sendMessageStream").mockImplementation(
    async () => {
      events.push("send");
      return { controller: new AbortController() } as never;
    },
  );
  try {
    const pending = startTurnInput({
      conversationId: "conv-1",
      agentId: "agent-1",
      socket: {
        kind: "local",
        bufferedAmount: 0,
        isOpen: () => true,
        send: () => {},
      },
      runtime,
      turnLease,
      workingDirectory: process.cwd(),
      permissionModeState: { mode: "standard" },
      preparedToolContext: undefined,
      overrideModel: undefined,
      getInput: () => ({
        messages: [{ role: "user", content: "delivered input" }],
      }),
      getInterruptedToolCallIds: () => [],
      onTerminal: () => {},
      finalizeTerminal: () => {
        throw new Error("Unexpected terminal");
      },
      getTurnId: () => "batch-1",
    });
    await Promise.resolve();
    expect(events).toEqual(["recovery"]);
    expect(submit).not.toHaveBeenCalled();
    release();
    await pending;
    expect(events).toEqual(["recovery", "resolved", "send"]);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(submit.mock.calls[0]?.[1])).toContain(
      "delivered input",
    );
  } finally {
    release();
    recover.mockRestore();
    submit.mockRestore();
  }
});
