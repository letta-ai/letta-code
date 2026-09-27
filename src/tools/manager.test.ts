import { afterEach, describe, expect, test } from "bun:test";
import { emptyEventEmissionResult, type ModEvents } from "@/mods/event-emitter";
import { type TelemetryEvent, telemetry } from "@/telemetry";
import { enableListenerExternalToolBackground } from "@/tools/external-tool-background-eligibility";

import {
  clearExternalTools,
  executeExternalTool,
  executeTool,
  getAllLettaToolNames,
  getClientToolsFromRegistry,
  prepareToolExecutionContextForModel,
  registerExternalTools,
  releaseToolExecutionContext,
} from "@/tools/manager";
import {
  clearPendingMessages,
  type QueuedMessage,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";

afterEach(() => {
  clearExternalTools();
  setMessageQueueAdder(null);
  clearPendingMessages();
});

function noToolEndHandlers(): ModEvents {
  return {
    hasHandlers: () => false,
    emit: async (name) => emptyEventEmissionResult(name),
  };
}

function currentNotificationGuard() {
  return {
    isCurrent: () => true,
    waitUntilCurrent: async () => true,
  };
}

async function executePreparedExternalTool(options: {
  modEvents?: ModEvents;
  toolName: string;
}) {
  const prepared = await prepareToolExecutionContextForModel(
    "anthropic/claude-sonnet-4",
    {
      clientToolAllowlist: [options.toolName],
      runtimeContext: {
        agentId: "agent-external",
        conversationId: "conv-external",
      },
      modEvents: options.modEvents,
    },
  );
  try {
    return await executeTool(
      options.toolName,
      {},
      { toolCallId: "call-external", toolContextId: prepared.contextId },
    );
  } finally {
    releaseToolExecutionContext(prepared.contextId);
  }
}

describe("external tool execution", () => {
  test("preserves text and image content", async () => {
    const result = await executeExternalTool(
      "call-1",
      "ScreenshotTool",
      {},
      async () => ({
        content: [
          { type: "text", text: "Desktop screenshot" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
        isError: false,
      }),
    );

    expect(result).toEqual({
      toolReturn: [
        { type: "text", text: "Desktop screenshot" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "aGVsbG8=",
          },
        },
      ],
      status: "success",
    });
  });

  test("preserves image-only content", async () => {
    const result = await executeExternalTool(
      "call-2",
      "ScreenshotTool",
      {},
      async () => ({
        content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" }],
        isError: false,
      }),
    );

    expect(result.toolReturn).toEqual([
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: "aGVsbG8=",
        },
      },
    ]);
  });

  test("keeps text-only content flattened", async () => {
    const result = await executeExternalTool(
      "call-3",
      "TextTool",
      {},
      async () => ({
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
        isError: false,
      }),
    );

    expect(result.toolReturn).toBe("first\nsecond");
  });
});

describe("external tool auto-background eligibility", () => {
  test("listener tools background when the mod wrapper has no tool_end handlers", async () => {
    const notifications: QueuedMessage[] = [];
    setMessageQueueAdder((message) => notifications.push(message));
    const tool = enableListenerExternalToolBackground(
      {
        name: "ListenerLookup",
        description: "Listener-owned lookup",
        parameters: { type: "object", properties: {} },
        autoBackground: true,
        executor: async () => {
          await Bun.sleep(25);
          return {
            content: [{ type: "text", text: "late listener result" }],
            isError: false,
          };
        },
      },
      { createNotificationGuard: currentNotificationGuard, yieldMs: 10 },
    );
    registerExternalTools([tool]);

    const result = await executePreparedExternalTool({
      modEvents: noToolEndHandlers(),
      toolName: tool.name,
    });
    expect(result.toolReturn).toContain("is still running");
    await Bun.sleep(30);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.text).toContain("late listener result");
  });

  test("listener tools stay inline when a tool_end handler can inspect the result", async () => {
    const notifications: QueuedMessage[] = [];
    setMessageQueueAdder((message) => notifications.push(message));
    const tool = enableListenerExternalToolBackground(
      {
        name: "RedactedLookup",
        description: "Listener-owned lookup with result hook",
        parameters: { type: "object", properties: {} },
        autoBackground: true,
        executor: async () => {
          await Bun.sleep(25);
          return {
            content: [{ type: "text", text: "actual result" }],
            isError: false,
          };
        },
      },
      { createNotificationGuard: currentNotificationGuard, yieldMs: 10 },
    );
    registerExternalTools([tool]);
    const modEvents: ModEvents = {
      hasHandlers: (name) => name === "tool_end",
      emit: async (name) => emptyEventEmissionResult(name),
    };

    const result = await executePreparedExternalTool({
      modEvents,
      toolName: tool.name,
    });
    expect(result.toolReturn).toBe("actual result");
    expect(notifications).toEqual([]);
  });

  test("listener tools stay inline when a tool_end handler appears during the foreground wait", async () => {
    const notifications: QueuedMessage[] = [];
    setMessageQueueAdder((message) => notifications.push(message));
    const tool = enableListenerExternalToolBackground(
      {
        name: "ReloadedHookLookup",
        description: "Listener lookup during mod reload",
        parameters: { type: "object", properties: {} },
        autoBackground: true,
        executor: async () => {
          await Bun.sleep(25);
          return {
            content: [{ type: "text", text: "result after reload" }],
            isError: false,
          };
        },
      },
      { createNotificationGuard: currentNotificationGuard, yieldMs: 10 },
    );
    registerExternalTools([tool]);
    let hasToolEndHandler = false;
    const modEvents: ModEvents = {
      hasHandlers: (name) => name === "tool_end" && hasToolEndHandler,
      emit: async (name) => emptyEventEmissionResult(name),
    };
    setTimeout(() => {
      hasToolEndHandler = true;
    }, 5);

    const result = await executePreparedExternalTool({
      modEvents,
      toolName: tool.name,
    });
    expect(result.toolReturn).toBe("result after reload");
    expect(notifications).toEqual([]);
  });

  test("direct SDK tools cannot enable backgrounding on the shared stdin path", async () => {
    const notifications: QueuedMessage[] = [];
    setMessageQueueAdder((message) => notifications.push(message));
    registerExternalTools([
      {
        name: "HeadlessLookup",
        description: "Direct SDK lookup",
        parameters: { type: "object", properties: {} },
        autoBackground: true,
        executor: async () => {
          await Bun.sleep(25);
          return {
            content: [{ type: "text", text: "headless result" }],
            isError: false,
          };
        },
      },
    ]);

    const result = await executePreparedExternalTool({
      toolName: "HeadlessLookup",
    });
    expect(result.toolReturn).toBe("headless result");
    expect(notifications).toEqual([]);
  });
});

describe("MessageChannel architecture", () => {
  test("tracks gateway channel results once, including errors, without message content", async () => {
    const state = telemetry as unknown as {
      events: TelemetryEvent[];
      toolCallCount: number;
    };
    const originalEvents = state.events;
    const originalToolCallCount = state.toolCallCount;
    const originalSetting = process.env.LETTA_CODE_TELEM;
    state.events = [];
    process.env.LETTA_CODE_TELEM = "1";
    try {
      for (const outcome of ["success", "error", "throw"] as const) {
        const result = await executeExternalTool(
          `call-${outcome}`,
          "MessageChannel",
          {
            channel: "slack",
            action: "send",
            message: "private body",
            chat_id: "private-id",
          },
          async () => {
            if (outcome === "throw") throw new Error("transport failed");
            return {
              content: [{ type: "text", text: outcome }],
              isError: outcome === "error",
            };
          },
        );
        expect(result.status).toBe(outcome === "success" ? "success" : "error");
      }
      expect(state.events).toHaveLength(3);
      expect(state.events.map((event) => event.data.success)).toEqual([
        true,
        false,
        false,
      ]);
      for (const event of state.events) {
        expect(event.type).toBe("tool_usage");
        expect(event.data.channel).toBe("slack");
        expect(event.data.channel_action).toBe("send");
      }
      expect(JSON.stringify(state.events)).not.toContain("private");
    } finally {
      state.events = originalEvents;
      state.toolCallCount = originalToolCallCount;
      if (originalSetting === undefined) delete process.env.LETTA_CODE_TELEM;
      else process.env.LETTA_CODE_TELEM = originalSetting;
    }
  });

  test("does not register any channel delivery tool as a built-in", () => {
    const toolNames = new Set(getAllLettaToolNames());

    expect(toolNames.has("MessageChannel")).toBe(false);
    expect(toolNames.has("MessageSlackChannel")).toBe(false);
    expect(toolNames.has("MessageTelegramChannel")).toBe(false);
    expect(toolNames.has("slack")).toBe(false);
    expect(toolNames.has("telegram")).toBe(false);
  });

  test("exposes the gateway-owned MessageChannel definition", () => {
    registerExternalTools([
      {
        name: "MessageChannel",
        registrationKey: "gateway:MessageChannel",
        description: "Gateway-owned channel delivery",
        parameters: {
          type: "object",
          properties: { message: { type: "string" } },
        },
      },
    ]);

    const matches = getClientToolsFromRegistry().filter(
      (tool) => tool.name === "MessageChannel",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.description).toBe("Gateway-owned channel delivery");
  });
});
