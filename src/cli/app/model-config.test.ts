import { describe, expect, test } from "bun:test";
import {
  deriveReasoningEffort,
  mapHandleToLlmConfigPatch,
  providerTypeFromModelSettings,
  providerTypeFromUpdateArgs,
} from "./model-config";

describe("model config helpers", () => {
  test("maps custom ChatGPT OAuth alias handles using provider type metadata", () => {
    expect(
      mapHandleToLlmConfigPatch("chatgpt-personal/gpt-5.5", "chatgpt_oauth"),
    ).toEqual({
      model: "gpt-5.5",
      model_endpoint_type: "chatgpt_oauth",
    });
  });

  test("does not invent endpoint type from unknown aliases without metadata", () => {
    expect(mapHandleToLlmConfigPatch("chatgpt-personal/gpt-5.5")).toEqual({
      model: "chatgpt-personal/gpt-5.5",
    });
  });

  test("maps Kimi K3 direct and OpenRouter handles to backend llm_config fields", () => {
    expect(
      mapHandleToLlmConfigPatch("moonshot/kimi-k3") as Record<string, unknown>,
    ).toEqual({
      model: "kimi-k3",
      model_endpoint_type: "moonshot",
    });
    expect(
      mapHandleToLlmConfigPatch("openrouter/moonshotai/kimi-k3") as Record<
        string,
        unknown
      >,
    ).toEqual({
      model: "moonshotai/kimi-k3",
      model_endpoint_type: "openrouter",
    });
  });

  test("extracts provider type from model settings and update args", () => {
    expect(
      providerTypeFromModelSettings({ provider_type: "chatgpt_oauth" }),
    ).toBe("chatgpt_oauth");
    expect(providerTypeFromUpdateArgs({ provider_type: "chatgpt_oauth" })).toBe(
      "chatgpt_oauth",
    );
  });

  test("derives GPT-5.6 max from OpenAI-family model settings", () => {
    expect(
      deriveReasoningEffort(
        {
          provider_type: "chatgpt_oauth",
          reasoning: { reasoning_effort: "max" },
        } as never,
        null,
      ),
    ).toBe("max");
  });

  test("derives Kimi K3 max from Moonshot model settings", () => {
    expect(
      deriveReasoningEffort(
        {
          provider_type: "moonshot",
          reasoning_effort: "max",
        } as never,
        null,
      ),
    ).toBe("max");
  });

  test("does not expose unsupported Moonshot reasoning tiers", () => {
    expect(
      deriveReasoningEffort(
        {
          provider_type: "moonshot",
          reasoning_effort: "low",
        } as never,
        null,
      ),
    ).toBeNull();
  });
});
