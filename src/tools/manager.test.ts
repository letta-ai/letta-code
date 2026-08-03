import { afterEach, describe, expect, test } from "bun:test";

import {
  clearExternalTools,
  getAllLettaToolNames,
  getClientToolsFromRegistry,
  registerExternalTools,
} from "@/tools/manager";

afterEach(() => clearExternalTools());

describe("MessageChannel architecture", () => {
  test("exposes one shared channel tool instead of provider-specific tools", () => {
    const toolNames = new Set(getAllLettaToolNames());

    expect(toolNames.has("MessageChannel")).toBe(true);

    expect(toolNames.has("MessageSlackChannel")).toBe(false);
    expect(toolNames.has("MessageTelegramChannel")).toBe(false);
    expect(toolNames.has("slack")).toBe(false);
    expect(toolNames.has("telegram")).toBe(false);
  });

  test("an external MessageChannel definition shadows the built-in payload", () => {
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
