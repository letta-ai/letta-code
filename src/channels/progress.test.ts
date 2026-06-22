import { expect, test } from "bun:test";
import {
  buildChannelTurnProgressUpdatesFromDelta,
  sanitizeChannelProgressText,
} from "@/channels/progress";
import type { StreamDelta } from "@/types/protocol_v2";

test("channel progress converts tool call deltas without leaking args", () => {
  const updates = buildChannelTurnProgressUpdatesFromDelta({
    message_type: "tool_call_message",
    run_id: "run-1",
    tool_calls: [
      {
        id: "call-1",
        function: {
          name: "shell_exec",
          arguments: "token=super-secret @channel",
        },
      },
    ],
  } as unknown as StreamDelta);

  expect(updates).toEqual([
    {
      kind: "tool",
      state: "started",
      message: "Preparing tool: shell_exec",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "shell_exec",
    },
  ]);
});

test("channel progress sanitizes status text before adapters see it", () => {
  expect(
    sanitizeChannelProgressText(
      "Running\u001b[31m TOKEN=abc123 @channel <unsafe>\nnext",
      80,
    ),
  ).toBe("Running TOKEN=[redacted] @​channel <unsafe> next");
});

test("channel progress maps lifecycle stream deltas to generic updates", () => {
  expect(
    buildChannelTurnProgressUpdatesFromDelta({
      message_type: "retry",
      attempt: 2,
      max_attempts: 4,
    } as unknown as StreamDelta),
  ).toEqual([
    {
      kind: "retry",
      state: "updated",
      message: "Retrying request (2/4)",
    },
  ]);

  expect(
    buildChannelTurnProgressUpdatesFromDelta({
      message_type: "loop_error",
    } as unknown as StreamDelta),
  ).toEqual([
    {
      kind: "error",
      state: "error",
      message: "Encountered an error",
    },
  ]);
});
