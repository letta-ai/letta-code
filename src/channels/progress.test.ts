import { expect, test } from "bun:test";
import {
  createChannelTurnProgressBuilder,
  sanitizeChannelProgressText,
} from "@/channels/progress";
import type { StreamDelta } from "@/types/protocol_v2";

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
      toolDetails: "failed",
      toolTitle: "Tried to write lib.rs",
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

test("channel progress labels client-side tool execution events", () => {
  const builder = createChannelTurnProgressBuilder();
  const updates = builder.buildUpdates({
    message_type: "client_tool_start",
    run_id: "run-1",
    tool_call_id: "call-1",
    tool_name: "Read",
    tool_args: JSON.stringify({
      file_path: "/repo/README.md",
    }),
  } as unknown as StreamDelta);

  expect(updates).toEqual([
    {
      kind: "tool",
      state: "started",
      message: "Running tool",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "Read",
      toolDetails: "/repo/README.md",
      toolTitle: "Reading README.md",
    },
  ]);
});

test("channel progress completes client-side tool rows from cached metadata", () => {
  const builder = createChannelTurnProgressBuilder();
  builder.buildUpdates({
    message_type: "client_tool_start",
    run_id: "run-1",
    tool_call_id: "call-1",
    tool_name: "Read",
    tool_args: JSON.stringify({
      file_path: "/repo/README.md",
    }),
  } as unknown as StreamDelta);

  expect(
    builder.buildUpdates({
      message_type: "client_tool_end",
      run_id: "run-1",
      tool_call_id: "call-1",
      status: "success",
    } as unknown as StreamDelta),
  ).toEqual([
    {
      kind: "tool",
      state: "completed",
      message: "Tool finished",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "Read",
      toolDetails: "/repo/README.md",
      toolTitle: "Read README.md",
    },
  ]);
});

test("channel progress waits for streamed exec_command descriptions", () => {
  const builder = createChannelTurnProgressBuilder();
  expect(
    builder.buildUpdates({
      message_type: "approval_request_message",
      run_id: "run-1",
      tool_calls: {
        tool_call_id: "call-1",
        name: "exec_command",
        arguments: null,
      },
    } as unknown as StreamDelta),
  ).toEqual([
    {
      kind: "tool",
      state: "started",
      message: "Preparing tool: exec_command",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "exec_command",
    },
  ]);

  let updates = builder.buildUpdates({
    message_type: "approval_request_message",
    run_id: "run-1",
    tool_calls: {
      tool_call_id: "call-1",
      name: null,
      arguments: '{"cmd":"git status --short","description":"Check',
    },
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

  updates = builder.buildUpdates({
    message_type: "approval_request_message",
    run_id: "run-1",
    tool_calls: {
      tool_call_id: "call-1",
      name: null,
      arguments: ' working tree status"}',
    },
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

test("channel progress remembers tool names across streamed Skill args", () => {
  const builder = createChannelTurnProgressBuilder();
  builder.buildUpdates({
    message_type: "approval_request_message",
    run_id: "run-1",
    tool_call: {
      tool_call_id: "call-1",
      name: "Skill",
      arguments: null,
    },
  } as unknown as StreamDelta);

  const updates = builder.buildUpdates({
    message_type: "approval_request_message",
    run_id: "run-1",
    tool_call: {
      tool_call_id: "call-1",
      name: null,
      arguments: JSON.stringify({
        skill: "maintaining-machine-maintenance",
      }),
    },
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

test("channel progress renders approval request deltas as tool rows", () => {
  const builder = createChannelTurnProgressBuilder();
  const updates = builder.buildUpdates({
    message_type: "approval_request_message",
    run_id: "run-1",
    tool_calls: [
      {
        tool_call_id: "approval-1",
        name: "Bash",
        arguments: JSON.stringify({
          command: "ls src/channels",
          description: "List channel source files",
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
      toolCallId: "approval-1",
      toolName: "Bash",
      toolDetails: "List channel source files",
    },
  ]);
});

test("channel progress extracts tool details when arguments is an object", () => {
  const builder = createChannelTurnProgressBuilder();
  const updates = builder.buildUpdates({
    message_type: "approval_request_message",
    run_id: "run-1",
    tool_calls: [
      {
        tool_call_id: "approval-1",
        name: "Bash",
        arguments: {
          command: "ls src/channels",
          description: "List channel source files",
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
      toolCallId: "approval-1",
      toolName: "Bash",
      toolDetails: "List channel source files",
    },
  ]);
});

test("channel progress falls back to shell command preview when description is missing", () => {
  const builder = createChannelTurnProgressBuilder();
  const updates = builder.buildUpdates({
    message_type: "tool_call_message",
    run_id: "run-1",
    tool_calls: [
      {
        tool_call_id: "call-1",
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: "git diff --stat; git status --short",
          shell: "powershell",
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
      toolDetails: "git diff --stat; git status --short",
    },
  ]);
});

test("channel progress resolves details from accumulated args on tool return", () => {
  const builder = createChannelTurnProgressBuilder();
  builder.buildUpdates({
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
      toolName: "exec_command",
      toolDetails: "Check working tree status",
    },
  ]);
});

test("channel progress builders do not share accumulated state", () => {
  const firstBuilder = createChannelTurnProgressBuilder();
  firstBuilder.buildUpdates({
    message_type: "tool_call_message",
    run_id: "run-1",
    tool_calls: [
      {
        tool_call_id: "call-1",
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: "git status --short",
        }),
      },
    ],
  } as unknown as StreamDelta);

  // A different turn's builder must not see the first turn's cached
  // arguments or tool names for the same tool_call_id.
  const secondBuilder = createChannelTurnProgressBuilder();
  expect(
    secondBuilder.buildUpdates({
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
    },
  ]);
});

test("channel progress maps canonical parallel tool return arrays", () => {
  const builder = createChannelTurnProgressBuilder();
  const updates = builder.buildUpdates({
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
      toolDetails: "failed",
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
  const builder = createChannelTurnProgressBuilder();
  expect(
    builder.buildUpdates({
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
    builder.buildUpdates({
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
