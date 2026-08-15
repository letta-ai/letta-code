import { afterEach, describe, expect, test } from "bun:test";

import {
  clearExternalTools,
  getAllLettaToolNames,
  getClientToolsFromRegistry,
  registerExternalTools,
} from "@/tools/manager";

afterEach(() => clearExternalTools());

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
