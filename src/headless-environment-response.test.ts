import { describe, expect, test } from "bun:test";
import { __headlessTestUtils } from "@/headless";

function assistantMessage(id: string, text: string, createdAt: string) {
  return {
    id,
    message_type: "assistant_message",
    created_at: createdAt,
    content: [{ type: "text", text }],
  };
}

describe("headless environment-routed responses", () => {
  test("waits for turn completion before returning the latest assistant message", async () => {
    const startedAtMs = Date.parse("2026-07-07T12:00:00.000Z");
    const baselineCompletionMs = Date.parse("2026-07-07T11:59:00.000Z");
    let retrieveCalls = 0;
    let messageCalls = 0;

    const backend = {
      async retrieveAgent() {
        retrieveCalls += 1;
        if (retrieveCalls < 3) {
          return {
            id: "agent-env",
            last_run_completion: "2026-07-07T11:59:00.000Z",
            last_stop_reason: "end_turn",
          };
        }
        return {
          id: "agent-env",
          last_run_completion: "2026-07-07T12:00:06.000Z",
          last_stop_reason: "end_turn",
        };
      },
      async listConversationMessages() {
        messageCalls += 1;
        if (messageCalls < 4) {
          return [
            assistantMessage(
              "msg-initial",
              "Let me gather the concrete details.",
              "2026-07-07T12:00:01.000Z",
            ),
          ];
        }
        return [
          assistantMessage(
            "msg-final",
            "Here's my concrete execution environment.",
            "2026-07-07T12:00:05.000Z",
          ),
          assistantMessage(
            "msg-initial",
            "Let me gather the concrete details.",
            "2026-07-07T12:00:01.000Z",
          ),
        ];
      },
      async listAgentMessages() {
        throw new Error("default conversation path should not be used");
      },
    };

    const result = await __headlessTestUtils.waitForEnvironmentAssistantMessage(
      {
        backend: backend as never,
        agentId: "agent-env",
        conversationId: "conv-env",
        startedAtMs,
        baselineLastRunCompletionMs: baselineCompletionMs,
        pollIntervalMs: 0,
        timeoutMs: 1_000,
      },
    );

    expect(result).toEqual({
      text: "Here's my concrete execution environment.",
      stopReason: "end_turn",
    });
    expect(messageCalls).toBeGreaterThanOrEqual(5);
  });
});
