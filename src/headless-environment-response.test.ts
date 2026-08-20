import { describe, expect, test } from "bun:test";
import { waitForEnvironmentAssistantMessage } from "@/headless-environment-response";

function assistantMessage(
  id: string,
  text: string,
  runId: string,
  sequenceId: number,
) {
  return {
    id,
    message_type: "assistant_message",
    date: "2026-07-07T12:00:00.000Z",
    content: [{ type: "text", text }],
    run_id: runId,
    seq_id: sequenceId,
  };
}

function userMessage(
  id: string,
  otid: string,
  runId: string,
  sequenceId: number,
  content = "Run the requested command",
) {
  return {
    id,
    message_type: "user_message",
    date: "2026-07-07T12:00:00.000Z",
    content,
    otid,
    run_id: runId,
    seq_id: sequenceId,
  };
}

describe("headless environment-routed responses", () => {
  test("follows the submitted input across continuation runs", async () => {
    let messageCalls = 0;
    const retrievedRunIds: string[] = [];

    const backend = {
      async retrieveRun(runId: string) {
        retrievedRunIds.push(runId);
        return {
          id: runId,
          status: "completed",
          stop_reason:
            runId === "run-requested" ? "requires_approval" : "end_turn",
        };
      },
      async listConversationMessages() {
        messageCalls += 1;
        if (messageCalls === 1) {
          return [
            assistantMessage(
              "msg-unrelated",
              "paused. the uncommitted fix only changes the test.",
              "run-unrelated",
              10,
            ),
          ];
        }
        if (messageCalls === 2) {
          return [
            assistantMessage(
              "msg-unrelated",
              "paused. the uncommitted fix only changes the test.",
              "run-unrelated",
              10,
            ),
            assistantMessage(
              "msg-initial",
              "Let me gather the concrete details.",
              "run-requested",
              12,
            ),
            userMessage("msg-user", "otid-requested", "run-requested", 11),
          ];
        }
        return [
          assistantMessage(
            "msg-next-turn",
            "This belongs to the next user message.",
            "run-next-turn",
            18,
          ),
          userMessage("msg-next-user", "otid-next", "run-next-turn", 17),
          assistantMessage(
            "msg-final",
            "Here's my concrete execution environment.",
            "run-continuation",
            15,
          ),
          assistantMessage(
            "msg-initial",
            "Let me gather the concrete details.",
            "run-requested",
            12,
          ),
          userMessage("msg-user", "otid-requested", "run-requested", 11),
          assistantMessage(
            "msg-unrelated",
            "paused. the uncommitted fix only changes the test.",
            "run-unrelated",
            10,
          ),
        ];
      },
      async listAgentMessages() {
        throw new Error("default conversation path should not be used");
      },
    };

    const result = await waitForEnvironmentAssistantMessage({
      backend: backend as never,
      agentId: "agent-env",
      conversationId: "conv-env",
      otid: "otid-requested",
      pollIntervalMs: 0,
      timeoutMs: 1_000,
    });

    expect(result).toEqual({
      text: "Here's my concrete execution environment.",
      stopReason: "end_turn",
    });
    expect(messageCalls).toBe(3);
    expect(retrievedRunIds).toEqual(["run-requested", "run-continuation"]);
  });

  test("ignores task notifications while following the submitted turn", async () => {
    const retrievedRunIds: string[] = [];
    const backend = {
      async retrieveRun(runId: string) {
        retrievedRunIds.push(runId);
        return {
          id: runId,
          status: "completed",
          stop_reason:
            runId === "run-requested" ? "requires_approval" : "end_turn",
        };
      },
      async listConversationMessages() {
        return [
          assistantMessage(
            "msg-final",
            "The background task completed successfully.",
            "run-final",
            15,
          ),
          userMessage(
            "msg-task-notification",
            "otid-task-notification",
            "run-task-notification",
            13,
            "<task-notification>background command completed</task-notification>",
          ),
          assistantMessage(
            "msg-initial",
            "Waiting for the background task.",
            "run-requested",
            12,
          ),
          userMessage("msg-user", "otid-requested", "run-requested", 11),
        ];
      },
      async listAgentMessages() {
        throw new Error("default conversation path should not be used");
      },
    };

    const result = await waitForEnvironmentAssistantMessage({
      backend: backend as never,
      agentId: "agent-env",
      conversationId: "conv-env",
      otid: "otid-requested",
      pollIntervalMs: 0,
      timeoutMs: 1_000,
    });

    expect(result).toEqual({
      text: "The background task completed successfully.",
      stopReason: "end_turn",
    });
    expect(retrievedRunIds).toEqual(["run-final"]);
  });
});
