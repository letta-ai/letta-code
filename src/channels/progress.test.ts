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

test("channel progress adds semantic web_search titles from safe args", () => {
  const updates = buildChannelTurnProgressUpdatesFromDelta({
    message_type: "tool_call_message",
    run_id: "run-1",
    tool_calls: [
      {
        id: "call-1",
        function: {
          name: "web_search",
          arguments: JSON.stringify({
            query: "letta blog",
            category: "article",
          }),
        },
      },
    ],
  } as unknown as StreamDelta);

  expect(updates).toEqual([
    {
      kind: "tool",
      state: "started",
      message: "Preparing tool: web_search",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "web_search",
      toolDetails: "letta blog",
      toolTitle: "Searching articles",
    },
  ]);
});

test("channel progress uses Letta Code display names for tool titles", () => {
  const updates = buildChannelTurnProgressUpdatesFromDelta({
    message_type: "tool_call_message",
    run_id: "run-1",
    tool_calls: [
      {
        id: "call-1",
        function: {
          name: "fetch_webpage",
          arguments: JSON.stringify({ url: "https://cameron.stream/blog" }),
        },
      },
    ],
  } as unknown as StreamDelta);

  expect(updates).toEqual([
    {
      kind: "tool",
      state: "started",
      message: "Preparing tool: fetch_webpage",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "fetch_webpage",
      toolDetails: "https://cameron.stream/blog",
      toolTitle: "Fetch Webpage",
    },
  ]);
});

test("channel progress uses Bash descriptions as tool titles", () => {
  const updates = buildChannelTurnProgressUpdatesFromDelta({
    message_type: "tool_call_message",
    run_id: "run-1",
    tool_calls: [
      {
        id: "call-1",
        function: {
          name: "Bash",
          arguments: JSON.stringify({
            command: "uname -a",
            description: "Check system details",
          }),
        },
      },
    ],
  } as unknown as StreamDelta);

  expect(updates).toEqual([
    {
      kind: "tool",
      state: "started",
      message: "Preparing tool: Bash",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "Bash",
      toolDetails: "Command: uname -a",
      toolTitle: "Bash: Check system details",
    },
  ]);
});

test("channel progress maps canonical parallel tool return arrays", () => {
  const updates = buildChannelTurnProgressUpdatesFromDelta({
    message_type: "tool_return_message",
    run_id: "run-1",
    tool_returns: [
      {
        tool_call_id: "call-1",
        status: "success",
        tool_return: "ok",
      },
      {
        tool_call_id: "call-2",
        status: "error",
        tool_return: "failed",
      },
    ],
  } as unknown as StreamDelta);

  expect(updates).toEqual([
    {
      kind: "tool",
      state: "completed",
      message: "Tool finished",
      runId: "run-1",
      toolCallId: "call-1",
    },
    {
      kind: "tool",
      state: "error",
      message: "Tool failed",
      runId: "run-1",
      toolCallId: "call-2",
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
