import { afterEach, describe, expect, test } from "bun:test";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { sendMessageStreamWithBackend } from "@/agent/message";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import type {
  HeadlessTurnExecutor,
  HeadlessTurnExecutorInput,
} from "@/backend/dev/headless-turn-executor";
import { createBuffers } from "@/cli/helpers/accumulator";
import { drainStream, drainStreamWithResume } from "@/cli/helpers/stream";
import { LOCAL_IN_PROCESS_STREAM } from "@/utils/stream-transport";

const originalStallMs = process.env.LETTA_STREAM_STALL_RECONCILE_MS;
const originalTerminalMs = process.env.LETTA_STREAM_TERMINAL_EOF_GRACE_MS;

afterEach(() => {
  __testSetBackend(null);
  if (originalStallMs === undefined) {
    delete process.env.LETTA_STREAM_STALL_RECONCILE_MS;
  } else {
    process.env.LETTA_STREAM_STALL_RECONCILE_MS = originalStallMs;
  }
  if (originalTerminalMs === undefined) {
    delete process.env.LETTA_STREAM_TERMINAL_EOF_GRACE_MS;
  } else {
    process.env.LETTA_STREAM_TERMINAL_EOF_GRACE_MS = originalTerminalMs;
  }
});

class CancelBeforeFirstChunkExecutor implements HeadlessTurnExecutor {
  calls = 0;
  private firstIteratorStartedResolve!: () => void;
  readonly firstIteratorStarted = new Promise<void>((resolve) => {
    this.firstIteratorStartedResolve = resolve;
  });

  async execute(input: HeadlessTurnExecutorInput) {
    this.calls += 1;
    const call = this.calls;
    const started = this.firstIteratorStartedResolve;
    return {
      controller: new AbortController(),
      async *[Symbol.asyncIterator]() {
        if (call === 1) {
          started();
          await new Promise<void>((resolve) => {
            if (input.signal.aborted) {
              resolve();
              return;
            }
            input.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return;
        }
        yield {
          message_type: "assistant_message",
          content: [{ type: "text", text: "resurrected provider work" }],
        } as LettaStreamingResponse;
        yield {
          message_type: "stop_reason",
          stop_reason: "end_turn",
        } as LettaStreamingResponse;
      },
    } as unknown as Stream<LettaStreamingResponse>;
  }
}

function localStream(
  iterator: (
    controller: AbortController,
  ) => AsyncGenerator<LettaStreamingResponse>,
) {
  const controller = new AbortController();
  return {
    controller,
    stream: {
      controller,
      [LOCAL_IN_PROCESS_STREAM]: true,
      [Symbol.asyncIterator]: () => iterator(controller),
    } as unknown as Stream<LettaStreamingResponse>,
  };
}

describe("local in-process stream transport recovery", () => {
  test("does not cancel a legitimate slow first token as an HTTP stall", async () => {
    process.env.LETTA_STREAM_STALL_RECONCILE_MS = "10";
    const { stream, controller } = localStream(async function* () {
      await new Promise((resolve) => setTimeout(resolve, 40));
      yield {
        message_type: "stop_reason",
        stop_reason: "end_turn",
      } as LettaStreamingResponse;
    });

    const result = await drainStream(
      stream,
      createBuffers("agent-local"),
      () => {},
    );

    expect(controller.signal.aborted).toBe(false);
    expect(result.stopReason).toBe("end_turn");
    expect(result.stallReconcilerFired).toBe(false);
  });

  test("does not use the HTTP EOF guard to abort a completed local run", async () => {
    process.env.LETTA_STREAM_TERMINAL_EOF_GRACE_MS = "10";
    const { stream, controller } = localStream(async function* () {
      yield {
        message_type: "stop_reason",
        stop_reason: "end_turn",
      } as LettaStreamingResponse;
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    const result = await drainStream(
      stream,
      createBuffers("agent-local"),
      () => {},
    );

    expect(controller.signal.aborted).toBe(false);
    expect(result.stopReason).toBe("end_turn");
    expect(result.terminalEofGuardFired).toBe(false);
  });

  test("backend cancellation before the first chunk cannot resume into a new local run", async () => {
    const agentId = "agent-local-cancel-before-first-chunk";
    const executor = new CancelBeforeFirstChunkExecutor();
    const backend = new FakeHeadlessBackend(agentId, executor);
    __testSetBackend(backend);
    const conversation = await backend.createConversation({
      agent_id: agentId,
    });
    const stream = await sendMessageStreamWithBackend(
      backend,
      conversation.id,
      [
        {
          role: "user",
          content: "Do not restart this turn after cancellation.",
          otid: "00000000-0000-4000-8000-000000000001",
        },
      ],
      {
        streamTokens: true,
        background: true,
        skillSources: [],
        preparedToolContext: {
          contextId: "ctx-local-cancel-before-first-chunk",
          clientTools: [],
          loadedToolNames: [],
        },
      },
    );
    const drainController = new AbortController();
    const pending = drainStreamWithResume(
      stream,
      createBuffers(agentId),
      () => {},
      drainController.signal,
      undefined,
      undefined,
      undefined,
      undefined,
      { initialDelayMs: 0, maxAttempts: 1, maxDelayMs: 0 },
    );
    await executor.firstIteratorStarted;

    await backend.cancelConversation(conversation.id);

    const result = await pending;
    expect(drainController.signal.aborted).toBe(false);
    expect(result.stopReason).toBe("cancelled");
    expect(result.sawStopReasonChunk).toBe(true);
    expect(result.lastRunId).toBeTruthy();
    expect(executor.calls).toBe(1);
  });
});
