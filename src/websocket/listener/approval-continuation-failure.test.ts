import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APIError } from "@letta-ai/letta-client/core/error";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import * as repositorySync from "@/agent/attached-repository-git-sync";
import { __testSetBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { settingsManager } from "@/settings-manager";
import {
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { setActiveRuntime } from "./runtime";
import { handleIncomingMessage } from "./turn";
import type { ConversationRuntime } from "./types";

function chunkStream(
  runId: string,
  chunks: Array<Record<string, unknown>>,
): Stream<LettaStreamingResponse> {
  return {
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      for (const [index, chunk] of chunks.entries()) {
        yield { run_id: runId, seq_id: index + 1, ...chunk };
      }
    },
  } as unknown as Stream<LettaStreamingResponse>;
}

/**
 * Runs a turn whose client-side tool executes and whose approval continuation
 * fails via `failContinuation`, then sends a fresh user input and returns the
 * messages that input carried.
 */
async function runFailedContinuationThenNextInput(
  failContinuation: (runtime: ConversationRuntime) => never,
) {
  const storageDir = await mkdtemp(join(tmpdir(), "listener-cont-fail-"));
  const sync = spyOn(
    repositorySync,
    "syncPendingAttachedRepositoryCommitsAfterTurn",
  ).mockResolvedValue({ results: [] });
  const backend = new LocalBackend({
    storageDir,
    executionMode: "deterministic",
    memfsEnabled: false,
  });
  const path = join(storageDir, "input.txt");
  await writeFile(path, "file contents");
  let runtime: ConversationRuntime | null = null;
  const bodies: Array<{ messages?: unknown[] }> = [];
  const request = spyOn(
    backend,
    "createConversationMessageStream",
  ).mockImplementation(async (_conversationId, body) => {
    bodies.push(body as { messages?: unknown[] });
    if (bodies.length === 1) {
      return chunkStream("run-tool", [
        {
          message_type: "approval_request_message",
          id: "message-tool",
          date: "2026-10-20T00:00:00Z",
          tool_call: {
            tool_call_id: "call-read",
            name: "Read",
            arguments: JSON.stringify({ file_path: path }),
          },
        },
        { message_type: "stop_reason", stop_reason: "requires_approval" },
      ]);
    }
    if (bodies.length === 2 && runtime) {
      failContinuation(runtime);
    }
    return chunkStream("run-next", [
      { message_type: "stop_reason", stop_reason: "end_turn" },
    ]);
  });
  const socket = {
    kind: "local" as const,
    bufferedAmount: 0,
    isOpen: () => true,
    send: () => {},
  };
  try {
    __testSetBackend(backend);
    await settingsManager.initialize();
    const agent = await backend.createAgent({
      name: "Continuation failure",
      model: "anthropic/claude-sonnet-4-6",
    });
    settingsManager.setMemfsEnabled(agent.id, false);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    });
    const listener = createRuntime();
    const scoped = getOrCreateScopedRuntime(
      listener,
      agent.id,
      conversation.id,
    );
    runtime = scoped;
    setActiveRuntime(listener);
    const options = {
      connectionId: "continuation-failure-test",
      wsUrl: "ws://test",
      deviceId: "test",
      connectionName: "Test",
      onConnected: () => {},
      onDisconnected: () => {},
      onError: () => {},
    };
    openListenerConnection({
      runtime: listener,
      connectionId: options.connectionId,
      writer: socket,
      options,
    }).initialized = true;
    subscribeListenerConnection(listener, options.connectionId, {
      agent_id: agent.id,
      conversation_id: conversation.id,
    });
    const send = (content: string) =>
      handleIncomingMessage(
        {
          type: "message",
          agentId: agent.id,
          conversationId: conversation.id,
          messages: [{ role: "user", content }],
        },
        socket,
        scoped,
      );

    await send("read the file");
    const parkedAfterFailure = scoped.pendingInterruptedResults;
    await send("what did it say?");

    return {
      parkedAfterFailure,
      requestCount: request.mock.calls.length,
      nextInput: bodies[2]?.messages ?? [],
      finalLifecycle: scoped.turnLifecycle.kind,
    };
  } finally {
    request.mockRestore();
    sync.mockRestore();
    __testSetBackend(null);
    setActiveRuntime(null);
    await rm(storageDir, { recursive: true, force: true });
  }
}

function expectApprovalResultsBeforeUserInput(nextInput: unknown[]) {
  expect(nextInput[0]).toEqual(
    expect.objectContaining({
      type: "approval",
      approvals: [
        expect.objectContaining({
          type: "tool",
          tool_call_id: "call-read",
          status: "success",
        }),
      ],
    }),
  );
  expect(nextInput.at(-1)).toEqual(
    expect.objectContaining({ role: "user", content: "what did it say?" }),
  );
}

test("a non-retryable continuation failure carries tool results into the next input", async () => {
  const result = await runFailedContinuationThenNextInput(() => {
    throw new APIError(
      429,
      { detail: "exceeded-quota" },
      undefined,
      new Headers(),
    );
  });

  expect(result.parkedAfterFailure).toEqual([
    expect.objectContaining({ tool_call_id: "call-read", status: "success" }),
  ]);
  // Exactly tool turn, failed continuation, next input: no pending-approval
  // conflict or stale-approval recovery request in between.
  expect(result.requestCount).toBe(3);
  expectApprovalResultsBeforeUserInput(result.nextInput);
  expect(result.finalLifecycle).toBe("idle");
}, 30_000);

test("a continuation aborted mid-send still carries tool results into the next input", async () => {
  const result = await runFailedContinuationThenNextInput((runtime) => {
    runtime.turnLifecycle.requestCancellation({ cause: "explicit_user" });
    throw new Error("aborted");
  });

  expect(result.parkedAfterFailure).toEqual([
    expect.objectContaining({ tool_call_id: "call-read", status: "success" }),
  ]);
  expect(result.requestCount).toBe(3);
  expectApprovalResultsBeforeUserInput(result.nextInput);
  expect(result.finalLifecycle).toBe("idle");
}, 30_000);
