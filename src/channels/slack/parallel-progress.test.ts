import { expect, test } from "bun:test";
import { ChannelGateway } from "@/channels/gateway-core";
import {
  FakeClient,
  makeDelivery,
  makeHooks,
  makeStreamDelta,
  makeTurnFinished,
} from "@/channels/gateway-test-support";
import { createChannelTurnProgressBuilder } from "@/channels/progress-builder";
import type { ChannelTurnSource } from "@/channels/types";
import { resolveSlackConcreteActivity } from "./progress";
import { createSlackStatusController } from "./status-controller";

function createProgressHarness() {
  const titles: string[] = [];
  const builder = createChannelTurnProgressBuilder();
  const source: ChannelTurnSource = {
    channel: "slack",
    chatId: "C123",
    threadId: "1712800000.000100",
    agentId: "agent-1",
    conversationId: "conv-1",
  };
  const status = createSlackStatusController({
    ensureApp: async () => ({}),
    ensureWriteClient: async () => ({
      assistant: {
        threads: {
          setStatus: async (args) => {
            titles.push(args.loading_messages?.[0] ?? "");
          },
        },
      },
    }),
    resolveKnownThreadRoot: (id) => id,
  });
  return {
    titles,
    status,
    source,
    async feed(delta: unknown) {
      const updates = builder.buildUpdates(delta);
      for (const update of updates) {
        const activity = resolveSlackConcreteActivity({
          ...update,
          type: "progress",
          sources: [source],
        });
        if (activity) await status.activate(source, "is working...", activity);
      }
      return updates;
    },
  };
}

function tool(id: string, description: string) {
  return {
    tool_call_id: id,
    name: "exec_command",
    arguments: JSON.stringify({ cmd: "true", description }),
  };
}

test("one model step keeps its first title through parallel starts and returns", async () => {
  const h = createProgressHarness();
  try {
    const tools = [
      tool("a", "Read source"),
      tool("b", "Run tests"),
      tool("c", "Inspect git history"),
    ];
    const updates = await h.feed({
      id: "message-1",
      step_id: "step-1",
      run_id: "run-1",
      message_type: "approval_request_message",
      tool_calls: tools,
    });
    // Other consumers still receive every tool's own details.
    expect(updates.map((update) => update.toolDetails)).toEqual([
      "Read source",
      "Run tests",
      "Inspect git history",
    ]);
    expect(h.titles).toEqual(["Read source"]);
    for (const tc of tools) {
      await h.feed({
        id: "message-1",
        message_type: "client_tool_start",
        tool_call_id: tc.tool_call_id,
        tool_name: tc.name,
        tool_args: tc.arguments,
      });
      expect(h.titles).toEqual(["Read source"]);
    }
    for (const tc of [...tools].reverse()) {
      await h.feed({
        message_type: "client_tool_end",
        tool_call_id: tc.tool_call_id,
        status: tc.tool_call_id === "b" ? "error" : "success",
      });
      expect(h.titles).toEqual(["Read source"]);
    }
    await h.feed({
      id: "message-2",
      step_id: "step-2",
      run_id: "run-1",
      message_type: "tool_call_message",
      tool_calls: [tool("d", "Check the result")],
    });
    expect(h.titles).toEqual(["Read source", "Check the result"]);
    await h.status.deactivate(h.source);
    expect(h.titles).toEqual(["Read source", "Check the result", ""]);
  } finally {
    h.status.clear();
  }
});

test("fragmented and mixed approval/server calls share the first useful step title", async () => {
  const h = createProgressHarness();
  try {
    await h.feed({
      id: "message-1",
      step_id: "step-1",
      message_type: "tool_call_message",
      tool_calls: {
        tool_call_id: "a",
        name: "exec_command",
        arguments: '{"cmd":"true","description":"Read',
      },
    });
    expect(h.titles).toEqual([]);
    await h.feed({
      id: "approval-1",
      step_id: "step-1",
      message_type: "approval_request_message",
      tool_calls: tool("b", "Run tests"),
    });
    expect(h.titles).toEqual(["Run tests"]);
    await h.feed({
      id: "message-1",
      step_id: "step-1",
      message_type: "tool_call_message",
      tool_calls: { tool_call_id: "a", arguments: ' source"}' },
    });
    expect(h.titles).toEqual(["Run tests"]);
    await h.feed({
      message_type: "tool_return_message",
      tool_returns: [
        { tool_call_id: "a", status: "success", tool_return: "done" },
        { tool_call_id: "b", status: "success", tool_return: "done" },
      ],
    });
    expect(h.titles).toEqual(["Run tests"]);
  } finally {
    h.status.clear();
  }
});

test("message-id batches preserve file titles through duplicate completions", async () => {
  const h = createProgressHarness();
  try {
    await h.feed({
      id: "message-1",
      message_type: "tool_call_message",
      tool_calls: [
        {
          tool_call_id: "a",
          name: "Read",
          arguments: JSON.stringify({ file_path: "/src/first.ts" }),
        },
        tool("b", "Run tests"),
      ],
    });
    const firstTitle = h.titles[0];
    if (!firstTitle) throw new Error("Expected a file progress title");
    expect(firstTitle).toContain("first.ts");
    expect(h.titles).toHaveLength(1);
    for (const messageType of ["client_tool_end", "tool_return_message"]) {
      await h.feed({
        message_type: messageType,
        tool_call_id: "a",
        status: "success",
      });
      expect(h.titles).toEqual([firstTitle]);
    }
    // A following step with no intervening reasoning can change the title.
    await h.feed({
      id: "message-2",
      message_type: "tool_call_message",
      tool_calls: [tool("c", "Check results")],
    });
    expect(h.titles).toEqual([firstTitle, "Check results"]);
  } finally {
    h.status.clear();
  }
});

test("untitled and MessageChannel calls cannot pin an empty or private status", async () => {
  const h = createProgressHarness();
  try {
    await h.feed({
      step_id: "step-1",
      message_type: "tool_call_message",
      tool_calls: [
        {
          tool_call_id: "message",
          name: "MessageChannel",
          arguments: JSON.stringify({ message: "Private reply text" }),
        },
        { tool_call_id: "unknown", name: "unknown", arguments: "{}" },
      ],
    });
    expect(h.titles).toEqual([]);
    await h.feed({
      step_id: "step-1",
      message_type: "tool_call_message",
      tool_calls: [tool("a", `Inspect <source> ${"x".repeat(70)}`)],
    });
    expect(h.titles).toHaveLength(1);
    expect(h.titles[0]).not.toContain("<");
    expect(h.titles[0]?.length).toBeLessThanOrEqual(50);
  } finally {
    h.status.clear();
  }
});

test("separate turns do not share the pinned title", async () => {
  const first = createProgressHarness();
  const second = createProgressHarness();
  try {
    for (const [h, description] of [
      [first, "First conversation"],
      [second, "Second conversation"],
    ] as const) {
      await h.feed({
        step_id: "step-1",
        message_type: "tool_call_message",
        tool_calls: [tool("a", description)],
      });
      expect(h.titles).toEqual([description]);
    }
  } finally {
    first.status.clear();
    second.status.clear();
  }
});

test("the gateway carries the batch title through queued hooks before cancellation", async () => {
  const h = createProgressHarness();
  const client = new FakeClient();
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const events: string[] = [];
  const { hooks } = makeHooks({
    onProgress: async (event) => {
      events.push(event.toolCallId ?? "");
      const activity = resolveSlackConcreteActivity(event);
      if (activity)
        await h.status.activate(h.source, "is working...", activity);
    },
    onLifecycle: async (event) => {
      if (event.type === "finished") {
        await h.status.deactivate(h.source);
        finish();
      }
    },
  });
  const gateway = new ChannelGateway(client, hooks);
  try {
    await gateway.submit(makeDelivery({ sources: [h.source] }));
    client.emit(
      makeStreamDelta({
        id: "message-1",
        step_id: "step-1",
        message_type: "tool_call_message",
        tool_calls: [tool("a", "Read source"), tool("b", "Run tests")],
      }),
    );
    client.emit(
      makeStreamDelta({
        message_type: "client_tool_start",
        tool_call_id: "b",
        tool_name: "exec_command",
      }),
    );
    client.emit(makeTurnFinished("cancelled"));
    await finished;
    expect(events).toEqual(["a", "b", "b"]);
    expect(h.titles).toEqual(["Read source", ""]);
  } finally {
    gateway.close();
    h.status.clear();
  }
});
