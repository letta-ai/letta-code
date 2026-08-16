import { afterEach, describe, expect, test } from "bun:test";

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
