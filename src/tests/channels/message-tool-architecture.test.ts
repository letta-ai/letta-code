import { describe, expect, test } from "bun:test";

import { getAllLettaToolNames } from "../../tools/manager";

describe("MessageChannel architecture", () => {
  test("exposes one shared channel tool instead of provider-specific tools", () => {
    const toolNames = new Set(getAllLettaToolNames());

    expect(toolNames.has("MessageChannel")).toBe(true);

    expect(toolNames.has("MessageSlackChannel")).toBe(false);
    expect(toolNames.has("MessageTelegramChannel")).toBe(false);
    expect(toolNames.has("slack")).toBe(false);
    expect(toolNames.has("telegram")).toBe(false);
  });
});
