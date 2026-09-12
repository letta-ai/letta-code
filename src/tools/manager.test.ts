import { afterEach, describe, expect, test } from "bun:test";
import { type TelemetryEvent, telemetry } from "@/telemetry";

import {
  clearExternalTools,
  executeExternalTool,
  getAllLettaToolNames,
  getClientToolsFromRegistry,
  registerExternalTools,
} from "@/tools/manager";

afterEach(() => clearExternalTools());

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
