import { describe, expect, test } from "bun:test";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { parseChatGPTUsageLimitDetail } from "@/agent/turn-recovery-policy";
import { StreamProcessor } from "@/cli/helpers/stream-processor";

describe("StreamProcessor structured errors", () => {
  test("preserves the quota code used by ChatGPT plan rotation", () => {
    const processor = new StreamProcessor();
    const result = processor.processChunk({
      message_type: "error_message",
      error_type: "insufficient_credits",
      message: "ChatGPT rate limit exceeded: The usage limit has been reached",
      detail: "ChatGPT rate limit exceeded:",
      error_code: "usage_limit_reached",
      kind: "insufficient_credits",
      retryable: false,
      run_id: "run-production-shape",
    } as unknown as LettaStreamingResponse);

    expect(result.errorInfo).toMatchObject({
      error_code: "usage_limit_reached",
      detail: "ChatGPT rate limit exceeded:",
    });
    expect(parseChatGPTUsageLimitDetail(result.errorInfo)).toEqual({
      planType: null,
      resetsAt: null,
    });
  });
});
