import { expect, test } from "bun:test";
import type { StreamDelta } from "@/types/protocol_v2";
import { createChannelTurnProgressBuilder } from "./progress-builder";

test("channel progress converts tool call deltas without leaking args", () => {
  const builder = createChannelTurnProgressBuilder();
  const updates = builder.buildUpdates({
    message_type: "tool_call_message",
    run_id: "run-1",
    tool_calls: [
      {
        tool_call_id: "call-1",
        name: "exec_command",
        arguments: "token=super-secret @channel",
      },
    ],
  } as unknown as StreamDelta);

  expect(updates).toEqual([
    {
      kind: "tool",
      state: "started",
      message: "Preparing tool: exec_command",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "exec_command",
    },
  ]);
});

test("channel progress uses web_search query as task details", () => {
  const builder = createChannelTurnProgressBuilder();
  const updates = builder.buildUpdates({
    message_type: "tool_call_message",
    run_id: "run-1",
    tool_calls: [
      {
        tool_call_id: "call-1",
        name: "web_search",
        arguments: JSON.stringify({
          query: "letta blog",
          category: "article",
        }),
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
    },
  ]);
});

test("channel progress uses Skill names as task details", () => {
  const builder = createChannelTurnProgressBuilder();
  const updates = builder.buildUpdates({
    message_type: "tool_call_message",
    run_id: "run-1",
    tool_calls: [
      {
        tool_call_id: "call-1",
        name: "Skill",
        arguments: JSON.stringify({
          skill: "maintaining-machine-maintenance",
        }),
      },
    ],
  } as unknown as StreamDelta);

  expect(updates).toEqual([
    {
      kind: "tool",
      state: "started",
      message: "Preparing tool: Skill",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "Skill",
      toolDetails: "maintaining-machine-maintenance",
      toolTitle: "Skill: maintaining-machine-maintenance",
    },
  ]);
});

test("channel progress uses Skill descriptions as task details when available", () => {
  const builder = createChannelTurnProgressBuilder({
    skillDescriptionsByName: {
      "scheduling-tasks": "Schedules reminders and recurring tasks via cron.",
    },
  });
  const updates = builder.buildUpdates({
    message_type: "tool_call_message",
    run_id: "run-1",
    tool_calls: [
      {
        tool_call_id: "call-1",
        name: "Skill",
        arguments: JSON.stringify({
          skill: "scheduling-tasks",
        }),
      },
    ],
  } as unknown as StreamDelta);

  expect(updates).toEqual([
    {
      kind: "tool",
      state: "started",
      message: "Preparing tool: Skill",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "Skill",
      toolDetails: "Schedules reminders and recurring tasks via cron.",
      toolTitle: "Skill: scheduling-tasks",
    },
  ]);
});

test("channel progress uses cached Skill names for streamed argument fragments", () => {
  const builder = createChannelTurnProgressBuilder();
  expect(
    builder.buildUpdates({
      message_type: "tool_call_message",
      run_id: "run-1",
      tool_calls: [
        {
          tool_call_id: "call-1",
          name: "Skill",
          arguments: '{"skill":"maintaining-',
        },
      ],
    } as unknown as StreamDelta),
  ).toEqual([
    {
      kind: "tool",
      state: "started",
      message: "Preparing tool: Skill",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "Skill",
    },
  ]);

  expect(
    builder.buildUpdates({
      message_type: "tool_call_message",
      run_id: "run-1",
      tool_calls: [
        {
          tool_call_id: "call-1",
          arguments: 'machine-maintenance"}',
        },
      ],
    } as unknown as StreamDelta),
  ).toEqual([
    {
      kind: "tool",
      state: "started",
      message: "Preparing tool: Skill",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "Skill",
      toolDetails: "maintaining-machine-maintenance",
      toolTitle: "Skill: maintaining-machine-maintenance",
    },
  ]);
});

test("channel progress recognizes namespaced Skill tool names", () => {
  const builder = createChannelTurnProgressBuilder();
  const updates = builder.buildUpdates({
    message_type: "tool_call_message",
    run_id: "run-1",
    tool_calls: [
      {
        tool_call_id: "call-1",
        name: "functions.Skill",
        arguments: JSON.stringify({
          skill: "working-on-letta-code-channels",
        }),
      },
    ],
  } as unknown as StreamDelta);

  expect(updates).toEqual([
    {
      kind: "tool",
      state: "started",
      message: "Preparing tool: functions.Skill",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "functions.Skill",
      toolDetails: "working-on-letta-code-channels",
      toolTitle: "Skill: working-on-letta-code-channels",
    },
  ]);
});

test("channel progress does not duplicate singular Skill alias fragments", () => {
  const builder = createChannelTurnProgressBuilder();
  const firstFragment = {
    tool_call_id: "call-1",
    name: "Skill",
    arguments: '{"skill":"turning-',
  };
  expect(
    builder.buildUpdates({
      message_type: "tool_call_message",
      run_id: "run-1",
      tool_call: firstFragment,
      tool_calls: firstFragment,
    } as unknown as StreamDelta),
  ).toEqual([
    {
      kind: "tool",
      state: "started",
      message: "Preparing tool: Skill",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "Skill",
    },
  ]);

  const secondFragment = {
    tool_call_id: "call-1",
    arguments: 'slack-asks-into-prs"}',
  };
  expect(
    builder.buildUpdates({
      message_type: "tool_call_message",
      run_id: "run-1",
      tool_call: secondFragment,
      tool_calls: secondFragment,
    } as unknown as StreamDelta),
  ).toEqual([
    {
      kind: "tool",
      state: "started",
      message: "Preparing tool: Skill",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "Skill",
      toolDetails: "turning-slack-asks-into-prs",
      toolTitle: "Skill: turning-slack-asks-into-prs",
    },
  ]);
});

test("channel progress previews subagent prompts", () => {
  const builder = createChannelTurnProgressBuilder();
  const updates = builder.buildUpdates({
    message_type: "tool_call_message",
    run_id: "run-1",
    tool_calls: [
      {
        tool_call_id: "call-1",
        name: "Agent",
        arguments: JSON.stringify({
          description: "Inspect Slack progress",
          prompt:
            "Review the Slack rich progress patch with TOKEN=secret and tell @channel nothing.",
          subagent_type: "general-purpose",
        }),
      },
    ],
  } as unknown as StreamDelta);

  expect(updates).toEqual([
    {
      kind: "tool",
      state: "started",
      message: "Preparing tool: Agent",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "Agent",
      toolDetails:
        "Review the Slack rich progress patch with TOKEN=[redacted] and tell @​channel nothing.",
    },
  ]);
});

test("channel progress truncates subagent previews with ASCII ellipses", () => {
  const builder = createChannelTurnProgressBuilder();
  const updates = builder.buildUpdates({
    message_type: "tool_call_message",
    run_id: "run-1",
    tool_calls: [
      {
        tool_call_id: "call-1",
        name: "Agent",
        arguments: JSON.stringify({
          prompt: "A".repeat(220),
          subagent_type: "general-purpose",
        }),
      },
    ],
  } as unknown as StreamDelta);

  expect(updates[0]?.toolDetails).toBe(`${"A".repeat(177)}...`);
  expect(updates[0]?.toolDetails).not.toContain("…");
});

test("channel progress keeps subagent prompt previews across streamed fragments", () => {
  const builder = createChannelTurnProgressBuilder();
  expect(
    builder.buildUpdates({
      message_type: "tool_call_message",
      run_id: "run-1",
      tool_calls: [
        {
          tool_call_id: "call-1",
          name: "Task",
          arguments: '{"prompt":"Audit Slack',
        },
      ],
    } as unknown as StreamDelta),
  ).toEqual([
    {
      kind: "tool",
      state: "started",
      message: "Preparing tool: Task",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "Task",
    },
  ]);

  expect(
    builder.buildUpdates({
      message_type: "tool_call_message",
      run_id: "run-1",
      tool_calls: [
        {
          tool_call_id: "call-1",
          arguments: ' progress rows"}',
        },
      ],
    } as unknown as StreamDelta),
  ).toEqual([
    {
      kind: "tool",
      state: "started",
      message: "Preparing tool: Task",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "Task",
      toolDetails: "Audit Slack progress rows",
    },
  ]);
});

test("channel progress previews fetch_webpage URLs", () => {
  const builder = createChannelTurnProgressBuilder();
  const updates = builder.buildUpdates({
    message_type: "tool_call_message",
    run_id: "run-1",
    tool_calls: [
      {
        tool_call_id: "call-1",
        name: "fetch_webpage",
        arguments: JSON.stringify({ url: "https://cameron.stream/blog" }),
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
    },
  ]);
});

test("channel progress builds file action titles with line counts", () => {
  const builder = createChannelTurnProgressBuilder();
  builder.buildUpdates({
    message_type: "tool_call_message",
    run_id: "run-1",
    tool_calls: [
      {
        tool_call_id: "call-1",
        name: "Edit",
        arguments: JSON.stringify({
          file_path: "/repo/src/map.rs",
          old_string: "a\nb\nc",
          new_string: "x\ny",
        }),
      },
    ],
  } as unknown as StreamDelta);

  expect(
    builder.buildUpdates({
      message_type: "tool_return_message",
      run_id: "run-1",
      tool_returns: [
        {
          tool_call_id: "call-1",
          status: "success",
          tool_return: "ok",
        },
      ],
    } as unknown as StreamDelta),
  ).toEqual([
    {
      kind: "tool",
      state: "completed",
      message: "Tool finished",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "Edit",
      toolDetails: "/repo/src/map.rs",
      toolTitle: "Updated map.rs +2 -3",
    },
  ]);
});

test("channel progress builds failed file titles", () => {
  const builder = createChannelTurnProgressBuilder();
  builder.buildUpdates({
    message_type: "tool_call_message",
    run_id: "run-1",
    tool_calls: [
      {
        tool_call_id: "call-1",
        name: "Write",
        arguments: JSON.stringify({
          file_path: "/repo/src/lib.rs",
          content: "new content",
        }),
      },
    ],
  } as unknown as StreamDelta);

  expect(
    builder.buildUpdates({
      message_type: "tool_return_message",
      run_id: "run-1",
      tool_returns: [
        {
          tool_call_id: "call-1",
          status: "error",
          tool_return: "failed",
        },
      ],
    } as unknown as StreamDelta),
  ).toEqual([
    {
      kind: "tool",
      state: "error",
      message: "Tool failed",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "Write",
      toolDetails: "/repo/src/lib.rs",
      errorDetails: "failed",
      toolTitle: "Tried to write lib.rs",
    },
  ]);
});

test("channel progress keeps shell error output out of toolDetails (LET-9509)", () => {
  const builder = createChannelTurnProgressBuilder();
  builder.buildUpdates({
    message_type: "tool_call_message",
    run_id: "run-1",
    tool_calls: [
      {
        tool_call_id: "call-1",
        name: "Bash",
        arguments: JSON.stringify({
          command: "gh run view 28890486751",
          description: "Check CI run status",
        }),
      },
    ],
  } as unknown as StreamDelta);

  const updates = builder.buildUpdates({
    message_type: "tool_return_message",
    run_id: "run-1",
    tool_returns: [
      {
        tool_call_id: "call-1",
        status: "error",
        tool_return:
          "Exit code: 1\nrun 28890486751 is still in progress; logs will be available when it is complete",
      },
    ],
  } as unknown as StreamDelta);

  expect(updates).toEqual([
    {
      kind: "tool",
      state: "error",
      message: "Tool failed",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "Bash",
      // Argument-derived: safe to use as a row title on rich surfaces.
      toolDetails: "Check CI run status",
      // Output preview: detail text only, never a title.
      errorDetails:
        "Exit code: 1 run 28890486751 is still in progress; logs will be available when it is complete",
    },
  ]);
});

test("channel progress emits only errorDetails when failed shell args never arrived", () => {
  const builder = createChannelTurnProgressBuilder();
  const updates = builder.buildUpdates({
    message_type: "tool_return_message",
    run_id: "run-1",
    tool_returns: [
      {
        tool_call_id: "call-9",
        name: "Bash",
        status: "error",
        tool_return: "Exit code: 1\nboom",
      },
    ],
  } as unknown as StreamDelta);

  expect(updates).toEqual([
    {
      kind: "tool",
      state: "error",
      message: "Tool failed",
      runId: "run-1",
      toolCallId: "call-9",
      toolName: "Bash",
      errorDetails: "Exit code: 1 boom",
    },
  ]);
});

test("channel progress uses Bash descriptions as task details", () => {
  const builder = createChannelTurnProgressBuilder();
  const updates = builder.buildUpdates({
    message_type: "tool_call_message",
    run_id: "run-1",
    tool_calls: [
      {
        tool_call_id: "call-1",
        name: "Bash",
        arguments: JSON.stringify({
          command: "uname -a",
          description: "Check system details",
        }),
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
      toolDetails: "Check system details",
    },
  ]);
});

test("channel progress uses exec_command descriptions as task details", () => {
  const builder = createChannelTurnProgressBuilder();
  const updates = builder.buildUpdates({
    message_type: "tool_call_message",
    run_id: "run-1",
    tool_calls: [
      {
        tool_call_id: "call-1",
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: "git status --short",
          description: "Check working tree status",
        }),
      },
    ],
  } as unknown as StreamDelta);

  expect(updates).toEqual([
    {
      kind: "tool",
      state: "started",
      message: "Preparing tool: exec_command",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "exec_command",
      toolDetails: "Check working tree status",
    },
  ]);
});
