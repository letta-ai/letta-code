import { describe, expect, test } from "bun:test";
import {
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
});
