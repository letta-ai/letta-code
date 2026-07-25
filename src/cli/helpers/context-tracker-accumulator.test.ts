import { describe, expect, test } from "bun:test";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import {
  createBuffers,
  markCurrentLineAsFinished,
  onChunk,
} from "@/cli/helpers/accumulator";
import { createContextTracker } from "@/cli/helpers/context-tracker";

function usageChunk(
  fields: Record<string, number | null | undefined>,
): LettaStreamingResponse {
  return {
    message_type: "usage_statistics",
    ...fields,
  } as LettaStreamingResponse;
}

describe("accumulator usage statistics", () => {
  test("captures all LettaUsageStatistics token metrics", () => {
    const buffers = createBuffers();

    onChunk(
      buffers,
      usageChunk({
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        step_count: 1,
        cached_input_tokens: 60,
        cache_write_tokens: 11,
        reasoning_tokens: 7,
        context_tokens: 512,
      }),
    );

    onChunk(
      buffers,
      usageChunk({
        prompt_tokens: 40,
        completion_tokens: 8,
        total_tokens: 48,
        step_count: 2,
        cached_input_tokens: 5,
        cache_write_tokens: 3,
        reasoning_tokens: 2,
        context_tokens: 640,
      }),
    );

    expect(buffers.usage.promptTokens).toBe(140);
    expect(buffers.usage.completionTokens).toBe(28);
    expect(buffers.usage.totalTokens).toBe(168);
    expect(buffers.usage.stepCount).toBe(3);
    expect(buffers.usage.cachedInputTokens).toBe(65);
    expect(buffers.usage.cacheWriteTokens).toBe(14);
    expect(buffers.usage.reasoningTokens).toBe(9);
    // context_tokens is a snapshot value, so we keep the latest one.
    expect(buffers.usage.contextTokens).toBe(640);
  });

  test("tracks context_tokens even when provider token totals are zero", () => {
    const buffers = createBuffers();
    const tracker = createContextTracker();

    onChunk(
      buffers,
      usageChunk({
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        context_tokens: 512,
      }),
      tracker,
    );

    expect(buffers.usage.promptTokens).toBe(0);
    expect(buffers.usage.completionTokens).toBe(0);
    expect(buffers.usage.totalTokens).toBe(0);
    expect(buffers.usage.contextTokens).toBe(512);
    expect(tracker.lastContextTokens).toBe(512);
    expect(tracker.contextTokensHistory).toEqual([
      expect.objectContaining({
        tokens: 512,
        turnId: 0,
      }),
    ]);
  });

  test("ignores null optional token metrics", () => {
    const buffers = createBuffers();

    onChunk(
      buffers,
      usageChunk({
        cached_input_tokens: null,
        cache_write_tokens: null,
        reasoning_tokens: null,
        context_tokens: null,
      }),
    );

    expect(buffers.usage.cachedInputTokens).toBe(0);
    expect(buffers.usage.cacheWriteTokens).toBe(0);
    expect(buffers.usage.reasoningTokens).toBe(0);
    expect(buffers.usage.contextTokens).toBeUndefined();
  });

  test("sets reflection trigger only after compaction summary message", () => {
    const buffers = createBuffers("agent-1");
    const tracker = createContextTracker();

    onChunk(
      buffers,
      {
        message_type: "event_message",
        otid: "evt-compaction-1",
        event_type: "compaction",
        event_data: {},
      },
      tracker,
    );

    expect(tracker.pendingReflectionTrigger).toBe(false);
    expect(tracker.pendingConversationDescriptionRegeneration).toBe(false);
    expect(buffers.byId.get("evt-compaction-1")).toMatchObject({
      kind: "event",
      eventType: "compaction",
      phase: "running",
    });

    onChunk(
      buffers,
      {
        message_type: "summary_message",
        otid: "evt-compaction-1",
        summary: "Compaction completed",
      },
      tracker,
    );

    expect(tracker.pendingCompaction).toBe(true);
    expect(tracker.pendingReflectionTrigger).toBe(true);
    expect(tracker.pendingConversationDescriptionRegeneration).toBe(true);
    expect(buffers.byId.get("evt-compaction-1")).toMatchObject({
      kind: "event",
      eventType: "compaction",
      phase: "finished",
    });
  });

  test("renders retry event messages as status lines", () => {
    const buffers = createBuffers("agent-1");

    onChunk(buffers, {
      message_type: "event_message",
      id: "retry-event-1",
      event_type: "retry",
      event_data: {
        attempt: 1,
        max_attempts: 3,
        delay_ms: 2000,
        message: "Cannot connect to API",
      },
    } as unknown as LettaStreamingResponse);

    expect(buffers.byId.get("retry-event-1")).toEqual({
      kind: "status",
      id: "retry-event-1",
      lines: [
        "Provider stream error, retrying (attempt 1/3, in 2s): Cannot connect to API",
      ],
    });
  });

  test("uses run sequence fallback ids for retry status events", () => {
    const buffers = createBuffers("agent-1");

    onChunk(buffers, {
      message_type: "event_message",
      run_id: "local-run-1",
      seq_id: 7,
      event_type: "retry",
      event_data: { attempt: 2, delay_ms: 250 },
    } as unknown as LettaStreamingResponse);

    expect(buffers.byId.get("local-run-1-retry-7")).toEqual({
      kind: "status",
      id: "local-run-1-retry-7",
      lines: ["Provider stream error, retrying (attempt 2, in 250ms)"],
    });
  });

  test("marks non-compaction event messages as finished immediately", () => {
    const buffers = createBuffers("agent-1");

    onChunk(buffers, {
      message_type: "event_message",
      id: "event-custom-1",
      event_type: "custom_notification",
      event_data: {},
    } as unknown as LettaStreamingResponse);

    expect(buffers.byId.get("event-custom-1")).toMatchObject({
      kind: "event",
      eventType: "custom_notification",
      phase: "finished",
    });
  });

  test("sets reflection trigger for legacy compaction summary user_message", () => {
    const buffers = createBuffers("agent-1");
    const tracker = createContextTracker();
    const legacySummary = JSON.stringify({
      type: "system_alert",
      message:
        "The following prior messages have been hidden due to the conversation context window being reached.\nThe following is a summary of the previous messages: compact summary",
    });

    onChunk(
      buffers,
      {
        message_type: "user_message",
        id: "legacy-compaction-1",
        content: legacySummary,
      } as unknown as LettaStreamingResponse,
      tracker,
    );

    expect(tracker.pendingCompaction).toBe(true);
    expect(tracker.pendingReflectionTrigger).toBe(true);
    expect(tracker.pendingConversationDescriptionRegeneration).toBe(true);
  });

  test("accumulates assistant messages when otid is missing but id is present", () => {
    const buffers = createBuffers();

    onChunk(buffers, {
      message_type: "assistant_message",
      id: "assistant-fallback-1",
      content: [{ type: "text", text: "Hello " }],
    } as unknown as LettaStreamingResponse);

    onChunk(buffers, {
      message_type: "assistant_message",
      id: "assistant-fallback-1",
      content: [{ type: "text", text: "world" }],
    } as unknown as LettaStreamingResponse);

    const line = buffers.byId.get("assistant-fallback-1");
    expect(line?.kind).toBe("assistant");
    expect(line && "text" in line ? line.text : "").toBe("Hello world");
  });

  test("keeps one assistant line when stream transitions id -> both -> otid", () => {
    const buffers = createBuffers();

    onChunk(buffers, {
      message_type: "assistant_message",
      id: "assistant-msg-1",
      content: [{ type: "text", text: "Hello " }],
    } as unknown as LettaStreamingResponse);

    onChunk(buffers, {
      message_type: "assistant_message",
      id: "assistant-msg-1",
      otid: "assistant-otid-1",
      content: [{ type: "text", text: "from " }],
    } as unknown as LettaStreamingResponse);

    onChunk(buffers, {
      message_type: "assistant_message",
      otid: "assistant-otid-1",
      content: [{ type: "text", text: "stream" }],
    } as unknown as LettaStreamingResponse);

    const line = buffers.byId.get("assistant-msg-1");
    expect(line?.kind).toBe("assistant");
    expect(line && "text" in line ? line.text : "").toBe("Hello from stream");
    expect(buffers.byId.get("assistant-otid-1")).toBeUndefined();
  });

  test("keeps one assistant line when stream transitions otid -> both -> id", () => {
    const buffers = createBuffers();

    onChunk(buffers, {
      message_type: "assistant_message",
      otid: "assistant-otid-2",
      content: [{ type: "text", text: "Hello " }],
    } as unknown as LettaStreamingResponse);

    onChunk(buffers, {
      message_type: "assistant_message",
      id: "assistant-msg-2",
      otid: "assistant-otid-2",
      content: [{ type: "text", text: "from " }],
    } as unknown as LettaStreamingResponse);

    onChunk(buffers, {
      message_type: "assistant_message",
      id: "assistant-msg-2",
      content: [{ type: "text", text: "stream" }],
    } as unknown as LettaStreamingResponse);

    const line = buffers.byId.get("assistant-otid-2");
    expect(line?.kind).toBe("assistant");
    expect(line && "text" in line ? line.text : "").toBe("Hello from stream");
    expect(buffers.byId.get("assistant-msg-2")).toBeUndefined();
  });

  test("keeps one reasoning line when stream transitions id -> both -> otid", () => {
    const buffers = createBuffers();

    onChunk(buffers, {
      message_type: "reasoning_message",
      id: "reasoning-msg-1",
      reasoning: "Think ",
    } as unknown as LettaStreamingResponse);

    onChunk(buffers, {
      message_type: "reasoning_message",
      id: "reasoning-msg-1",
      otid: "reasoning-otid-1",
      reasoning: "through ",
    } as unknown as LettaStreamingResponse);

    onChunk(buffers, {
      message_type: "reasoning_message",
      otid: "reasoning-otid-1",
      reasoning: "it",
    } as unknown as LettaStreamingResponse);

    const line = buffers.byId.get("reasoning-msg-1");
    expect(line?.kind).toBe("reasoning");
    expect(line && "text" in line ? line.text : "").toBe("Think through it");
    expect(buffers.byId.get("reasoning-otid-1")).toBeUndefined();
  });

  test("keeps one reasoning line when stream transitions otid -> both -> id", () => {
    const buffers = createBuffers();

    onChunk(buffers, {
      message_type: "reasoning_message",
      otid: "reasoning-otid-2",
      reasoning: "Think ",
    } as unknown as LettaStreamingResponse);

    onChunk(buffers, {
      message_type: "reasoning_message",
      id: "reasoning-msg-2",
      otid: "reasoning-otid-2",
      reasoning: "through ",
    } as unknown as LettaStreamingResponse);

    onChunk(buffers, {
      message_type: "reasoning_message",
      id: "reasoning-msg-2",
      reasoning: "it",
    } as unknown as LettaStreamingResponse);

    const line = buffers.byId.get("reasoning-otid-2");
    expect(line?.kind).toBe("reasoning");
    expect(line && "text" in line ? line.text : "").toBe("Think through it");
    expect(buffers.byId.get("reasoning-msg-2")).toBeUndefined();
  });

  test("separates reasoning and assistant lines when ids overlap", () => {
    const buffers = createBuffers();

    onChunk(buffers, {
      message_type: "reasoning_message",
      id: "shared-stream-id",
      reasoning: "Thinking... ",
    } as unknown as LettaStreamingResponse);

    onChunk(buffers, {
      message_type: "assistant_message",
      id: "shared-stream-id",
      content: [{ type: "text", text: "Final answer" }],
    } as unknown as LettaStreamingResponse);

    const reasoning = buffers.byId.get("shared-stream-id");
    const assistant = buffers.byId.get("assistant:shared-stream-id");

    expect(reasoning?.kind).toBe("reasoning");
    expect(reasoning && "text" in reasoning ? reasoning.text : "").toBe(
      "Thinking... ",
    );

    expect(assistant?.kind).toBe("assistant");
    expect(assistant && "text" in assistant ? assistant.text : "").toBe(
      "Final answer",
    );
  });

  test("stores the actual assistant message id even when the line id is synthetic", () => {
    const buffers = createBuffers();

    onChunk(buffers, {
      message_type: "reasoning_message",
      id: "shared-stream-id",
      reasoning: "Thinking... ",
    } as unknown as LettaStreamingResponse);

    onChunk(buffers, {
      message_type: "assistant_message",
      id: "shared-stream-id",
      content: [{ type: "text", text: "Final answer" }],
    } as unknown as LettaStreamingResponse);

    const assistant = buffers.byId.get("assistant:shared-stream-id");
    expect(assistant?.kind).toBe("assistant");
    expect(
      assistant && "messageId" in assistant ? assistant.messageId : undefined,
    ).toBe("shared-stream-id");
  });

  test("starts a new reasoning line when a new otid arrives for the same message id", () => {
    const buffers = createBuffers();

    onChunk(buffers, {
      message_type: "reasoning_message",
      id: "reasoning-msg-split",
      otid: "reasoning-otid-split-1",
      reasoning: "**Checking user preferences**\n\nFirst section.",
    } as unknown as LettaStreamingResponse);

    onChunk(buffers, {
      message_type: "reasoning_message",
      id: "reasoning-msg-split",
      otid: "reasoning-otid-split-2",
      reasoning: "**Interpreting math notations**\n\nSecond section.",
    } as unknown as LettaStreamingResponse);

    onChunk(buffers, {
      message_type: "reasoning_message",
      id: "reasoning-msg-split",
      reasoning: " More detail.",
    } as unknown as LettaStreamingResponse);

    const firstLine = buffers.byId.get("reasoning-msg-split");
    const secondLine = buffers.byId.get("reasoning-otid-split-2");

    expect(firstLine?.kind).toBe("reasoning");
    expect(firstLine && "text" in firstLine ? firstLine.text : "").toBe(
      "**Checking user preferences**\n\nFirst section.",
    );
    expect(
      firstLine && "phase" in firstLine ? firstLine.phase : undefined,
    ).toBe("finished");
    expect(buffers.byId.get("reasoning-otid-split-1")).toBeUndefined();

    expect(secondLine?.kind).toBe("reasoning");
    expect(secondLine && "text" in secondLine ? secondLine.text : "").toBe(
      "**Interpreting math notations**\n\nSecond section. More detail.",
    );
  });

  test("starts a new assistant line when a new otid arrives for the same message id", () => {
    const buffers = createBuffers();

    onChunk(buffers, {
      message_type: "assistant_message",
      id: "assistant-msg-split",
      otid: "assistant-otid-split-1",
      content: [{ type: "text", text: "First block." }],
    } as unknown as LettaStreamingResponse);

    onChunk(buffers, {
      message_type: "assistant_message",
      id: "assistant-msg-split",
      otid: "assistant-otid-split-2",
      content: [{ type: "text", text: "Second block." }],
    } as unknown as LettaStreamingResponse);

    onChunk(buffers, {
      message_type: "assistant_message",
      id: "assistant-msg-split",
      content: [{ type: "text", text: " More detail." }],
    } as unknown as LettaStreamingResponse);

    const firstLine = buffers.byId.get("assistant-msg-split");
    const secondLine = buffers.byId.get("assistant-otid-split-2");

    expect(firstLine?.kind).toBe("assistant");
    expect(firstLine && "text" in firstLine ? firstLine.text : "").toBe(
      "First block.",
    );
    expect(
      firstLine && "phase" in firstLine ? firstLine.phase : undefined,
    ).toBe("finished");
    expect(buffers.byId.get("assistant-otid-split-1")).toBeUndefined();

    expect(secondLine?.kind).toBe("assistant");
    expect(secondLine && "text" in secondLine ? secondLine.text : "").toBe(
      "Second block. More detail.",
    );
  });

  test("inserts a blank line before a streamed reasoning section heading in the same otid", () => {
    const buffers = createBuffers();

    onChunk(buffers, {
      message_type: "reasoning_message",
      id: "reasoning-msg-heading",
      otid: "reasoning-otid-heading",
      reasoning: "**Calculating math problems**\n\nFirst section.",
    } as unknown as LettaStreamingResponse);

    onChunk(buffers, {
      message_type: "reasoning_message",
      id: "reasoning-msg-heading",
      otid: "reasoning-otid-heading",
      reasoning: "**Computing with Python**\n\nSecond section.",
    } as unknown as LettaStreamingResponse);

    const line = buffers.byId.get("reasoning-msg-heading");
    expect(line?.kind).toBe("reasoning");
    expect(line && "text" in line ? line.text : "").toBe(
      "**Calculating math problems**\n\nFirst section.\n\n**Computing with Python**\n\nSecond section.",
    );
  });

  test("separates adjacent final reasoning headings before finalization", () => {
    const buffers = createBuffers();

    onChunk(buffers, {
      message_type: "reasoning_message",
      id: "reasoning-msg-final-heading",
      otid: "reasoning-otid-final-heading",
      reasoning: "**Planning protocol build error handling**",
    } as unknown as LettaStreamingResponse);

    onChunk(buffers, {
      message_type: "reasoning_message",
      id: "reasoning-msg-final-heading",
      otid: "reasoning-otid-final-heading",
      reasoning: "**Evaluating event sequence handling**",
    } as unknown as LettaStreamingResponse);

    markCurrentLineAsFinished(buffers);

    const line = buffers.byId.get("reasoning-msg-final-heading");
    expect(line?.kind).toBe("reasoning");
    expect(line && "text" in line ? line.text : "").toBe(
      "**Planning protocol build error handling**\n\n**Evaluating event sequence handling**",
    );
    expect(line && "phase" in line ? line.phase : "").toBe("finished");
  });

  test("retrofits a blank line when a streamed reasoning heading spans multiple chunks", () => {
    const buffers = createBuffers();

    onChunk(buffers, {
      message_type: "reasoning_message",
      id: "reasoning-msg-split-heading",
      otid: "reasoning-otid-split-heading",
      reasoning: "**Calculating math problems**\n\nFirst section.**Computing",
    } as unknown as LettaStreamingResponse);

    onChunk(buffers, {
      message_type: "reasoning_message",
      id: "reasoning-msg-split-heading",
      otid: "reasoning-otid-split-heading",
      reasoning: " with Python**\n\nSecond section.",
    } as unknown as LettaStreamingResponse);

    const line = buffers.byId.get("reasoning-msg-split-heading");
    expect(line?.kind).toBe("reasoning");
    expect(line && "text" in line ? line.text : "").toBe(
      "**Calculating math problems**\n\nFirst section.\n\n**Computing with Python**\n\nSecond section.",
    );
  });

  test("trims reasoning paragraph separator when promoting static split", () => {
    const buffers = createBuffers();
    buffers.tokenStreamingEnabled = true;

    const firstParagraph = "A".repeat(1500);
    onChunk(buffers, {
      message_type: "reasoning_message",
      id: "reasoning-static-split",
      reasoning: `${firstParagraph}\n\nSecond paragraph`,
    } as unknown as LettaStreamingResponse);

    const committed = buffers.byId.get("reasoning-static-split-split-0");
    const live = buffers.byId.get("reasoning-static-split");

    expect(committed?.kind).toBe("reasoning");
    expect(committed && "text" in committed ? committed.text : "").toBe(
      firstParagraph,
    );
    expect(live?.kind).toBe("reasoning");
    expect(live && "text" in live ? live.text : "").toBe("Second paragraph");
    expect(live && "isContinuation" in live ? live.isContinuation : false).toBe(
      true,
    );
  });

  test("trims trailing reasoning newlines when finalizing unsplit reasoning", () => {
    const buffers = createBuffers();

    onChunk(buffers, {
      message_type: "reasoning_message",
      id: "reasoning-final-newline",
      reasoning: "Creating a pull request\n\n",
    } as unknown as LettaStreamingResponse);
    markCurrentLineAsFinished(buffers);

    const line = buffers.byId.get("reasoning-final-newline");
    expect(line?.kind).toBe("reasoning");
    expect(line && "text" in line ? line.text : "").toBe(
      "Creating a pull request",
    );
    expect(line && "phase" in line ? line.phase : "").toBe("finished");
    expect(buffers.lastReasoning).toBe("Creating a pull request");
  });

  test("reconciles optimistic user lines to the backend message id via otid", () => {
    const buffers = createBuffers();
    buffers.byId.set("user-local-1", {
      kind: "user",
      id: "user-local-1",
      text: "hello",
      otid: "user-otid-1",
    });
    buffers.userLineIdByOtid.set("user-otid-1", "user-local-1");
    buffers.order.push("user-local-1");

    onChunk(buffers, {
      message_type: "user_message",
      id: "message-user-1",
      otid: "user-otid-1",
      content: "hello",
    } as unknown as LettaStreamingResponse);

    const userLine = buffers.byId.get("user-local-1");
    expect(userLine?.kind).toBe("user");
    expect(
      userLine && "messageId" in userLine ? userLine.messageId : undefined,
    ).toBe("message-user-1");
    expect(buffers.byId.get("message-user-1")).toBeUndefined();
  });
});
