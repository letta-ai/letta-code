import { describe, expect, test } from "bun:test";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { createBuffers, onChunk } from "../../cli/helpers/accumulator";
import { createContextTracker } from "../../cli/helpers/contextTracker";

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
    expect(tracker.pendingSkillsReinject).toBe(true);
    expect(tracker.pendingReflectionTrigger).toBe(true);
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
});
