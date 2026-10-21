import { describe, expect, test } from "bun:test";
import { setupRuntimeModelCatalogFixture } from "@/test-utils/runtime-model-catalog";
import { getNewAgentReasoningOptions } from "./profile-selection";

setupRuntimeModelCatalogFixture();

describe("new-agent model reasoning options", () => {
  test("offers provider Default for an OpenAI-compatible proxy", () => {
    expect(
      getNewAgentReasoningOptions("proxy/claude-opus-4-6", {
        handle: "proxy/claude-opus-4-6",
        label: "Claude Opus 4.6",
        providerType: "openai",
        openAICompatibleProxy: true,
      }).map((option) => option.effort),
    ).toEqual([
      null,
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("does not offer provider Default for the official OpenAI API", () => {
    expect(
      getNewAgentReasoningOptions("lc-openai/gpt-5.4", {
        handle: "lc-openai/gpt-5.4",
        label: "GPT-5.4",
        providerType: "openai",
        modelEndpoint: "https://api.openai.com/v1",
      }).map((option) => option.effort),
    ).toEqual(["none", "low", "medium", "high", "xhigh"]);
  });

  test("prefers reported proxy capabilities", () => {
    expect(
      getNewAgentReasoningOptions(
        "proxy/arbitrary-model",
        {
          handle: "proxy/arbitrary-model",
          label: "Arbitrary",
          providerType: "openai",
          openAICompatibleProxy: true,
        },
        { supported_efforts: ["low", "high"], mandatory: false },
      ).map((option) => option.effort),
    ).toEqual([null, "low", "high"]);
  });
});
