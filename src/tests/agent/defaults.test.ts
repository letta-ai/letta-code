import { describe, expect, test } from "bun:test";
import {
  DEFAULT_AGENT_CONFIGS,
  selectDefaultAgentModel,
} from "../../agent/defaults";
import {
  getPersonalityContent,
  getPersonalityHumanContent,
} from "../../agent/personality";

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

describe("default agent configs", () => {
  test("memo default agent is Letta Code with memo persona and human", () => {
    expect(DEFAULT_AGENT_CONFIGS.memo?.name).toBe("Letta Code");
    expect(DEFAULT_AGENT_CONFIGS.memo?.blockValues?.persona?.trim()).toBe(
      getPersonalityContent("memo").trim(),
    );
    expect(DEFAULT_AGENT_CONFIGS.memo?.blockValues?.human?.trim()).toBe(
      getPersonalityHumanContent("memo").trim(),
    );
  });
});
