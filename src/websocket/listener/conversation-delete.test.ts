import { describe, expect, test } from "bun:test";
import type { Backend } from "@/backend";
import { ConversationBusyError } from "@/backend/conversation-busy-error";
import { deleteConversationFromListener } from "./conversation-delete";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import type { ConversationRuntime } from "./types";

function recordingBackend(
  failures: Error[] = [],
): Backend & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    async deleteConversation(conversationId: string) {
      const failure = failures.shift();
      if (failure) throw failure;
      deleted.push(conversationId);
      return undefined as never;
    },
  } as unknown as Backend & { deleted: string[] };
}

function waitOnApproval(runtime: ConversationRuntime): () => void {
  runtime.pendingApprovalResolvers.set("approval-1", {
    requestId: "approval-1",
    connectionIds: new Set(),
    resolve: () => {},
    reject: () => {},
  });
  return () => runtime.pendingApprovalResolvers.delete("approval-1");
}

describe("deleteConversationFromListener", () => {
  test("refuses while the listener is waiting on an approval for the conversation", async () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    waitOnApproval(runtime);
    const backend = recordingBackend();

    await expect(
      deleteConversationFromListener(backend, "conv-1", { listener }),
    ).rejects.toBeInstanceOf(ConversationBusyError);

    expect(backend.deleted).toEqual([]);
    expect(listener.conversationRuntimes.get(runtime.key)).toBe(runtime);
  });

  test("deletes and removes the runtime once the conversation is idle", async () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const other = getOrCreateScopedRuntime(listener, "agent-1", "conv-2");
    const settle = waitOnApproval(runtime);
    const backend = recordingBackend();

    const deletion = deleteConversationFromListener(backend, "conv-1", {
      listener,
      waitForIdleMs: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(backend.deleted).toEqual([]);
    settle();
    await deletion;

    expect(backend.deleted).toEqual(["conv-1"]);
    expect(listener.conversationRuntimes.has(runtime.key)).toBe(false);
    expect(listener.conversationRuntimes.get(other.key)).toBe(other);
  });

  test("retries backend busy errors until the deadline but not other errors", async () => {
    const listener = createRuntime();
    const busyThenOk = recordingBackend([
      new ConversationBusyError("still saving"),
      new ConversationBusyError("still saving"),
    ]);
    await deleteConversationFromListener(busyThenOk, "conv-1", {
      listener,
      waitForIdleMs: 5_000,
    });
    expect(busyThenOk.deleted).toEqual(["conv-1"]);

    const alwaysBusy = recordingBackend(
      Array.from({ length: 100 }, () => new ConversationBusyError("busy")),
    );
    await expect(
      deleteConversationFromListener(alwaysBusy, "conv-1", {
        listener,
        waitForIdleMs: 250,
      }),
    ).rejects.toBeInstanceOf(ConversationBusyError);
    expect(alwaysBusy.deleted).toEqual([]);

    const notFound = recordingBackend([new Error("not found")]);
    await expect(
      deleteConversationFromListener(notFound, "conv-1", {
        listener,
        waitForIdleMs: 5_000,
      }),
    ).rejects.toThrow("not found");
    expect(notFound.deleted).toEqual([]);
  });
});
