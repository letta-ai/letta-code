import { describe, expect, test } from "bun:test";
import {
  buildChannelModelReasoningUnsupportedMessage,
  buildChannelModelReasoningUpdatedMessage,
  buildChannelModelReasoningUpdateFailedMessage,
  buildChannelModelReasoningUsageMessage,
  parseChannelModelArgs,
} from "./model-reasoning-command";

describe("channel model reasoning commands", () => {
  test("parses model and reasoning selections", () => {
    expect(parseChannelModelArgs("")).toEqual({ kind: "model" });
    expect(parseChannelModelArgs("openai/gpt-5")).toEqual({
      kind: "model",
      modelIdentifier: "openai/gpt-5",
    });
    expect(parseChannelModelArgs("reasoning HIGH")).toEqual({
      kind: "reasoning",
      reasoningEffort: "high",
    });
    expect(parseChannelModelArgs("reasoning default")).toEqual({
      kind: "reasoning",
      reasoningEffort: null,
    });
    expect(parseChannelModelArgs("reasoning ultra")).toEqual({
      kind: "invalid-reasoning",
    });
    expect(parseChannelModelArgs("reasoning")).toEqual({
      kind: "invalid-reasoning",
    });
  });

  test("builds channel-safe reasoning guidance and results", () => {
    expect(buildChannelModelReasoningUsageMessage("slack")).toContain(
      "@agent /model reasoning",
    );
    expect(
      buildChannelModelReasoningUpdatedMessage("slack", {
        modelLabel: "GPT-5",
        reasoningEffort: "high",
      }),
    ).toBe("Slack updated this conversation's reasoning for GPT-5 to High.");
    expect(
      buildChannelModelReasoningUnsupportedMessage("slack", {
        modelLabel: "GPT-5",
        requested: "max",
        supported: ["low", "high"],
      }),
    ).toContain("reasoning <low|high>");
    expect(
      buildChannelModelReasoningUpdateFailedMessage("slack", {
        modelLabel: "GPT-5",
        reasoningEffort: null,
        error: "boom",
      }),
    ).toBe("Slack could not set GPT-5 reasoning to Default: boom");
  });
});
