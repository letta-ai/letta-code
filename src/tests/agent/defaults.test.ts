import { describe, expect, test } from "bun:test";
import { selectDefaultAgentModel } from "../../agent/defaults";

describe("selectDefaultAgentModel", () => {
  test("uses the caller's preferred model when it is available on self-hosted", () => {
    const result = selectDefaultAgentModel({
      preferredModel: "haiku",
      isSelfHosted: true,
      availableHandles: ["anthropic/claude-haiku-4-5"],
    });

    expect(result).toBe("anthropic/claude-haiku-4-5");
  });

  test("falls back to a server-available non-auto handle on self-hosted", () => {
    const result = selectDefaultAgentModel({
      isSelfHosted: true,
      availableHandles: ["letta/auto", "anthropic/claude-haiku-4-5"],
    });

    expect(result).toBe("anthropic/claude-haiku-4-5");
  });

  test("passes through the preferred model on cloud", () => {
    const result = selectDefaultAgentModel({
      preferredModel: "haiku",
      isSelfHosted: false,
      availableHandles: ["letta/auto"],
    });

    expect(result).toBe("anthropic/claude-haiku-4-5");
  });
});
