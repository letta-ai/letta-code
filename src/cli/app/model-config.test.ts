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
});
