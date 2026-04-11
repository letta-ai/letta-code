import { describe, expect, test } from "bun:test";
import {
  getByokProviderBaseUrl,
  ZAI_CODING_BASE_URL,
} from "../../providers/byok-providers";

describe("getByokProviderBaseUrl", () => {
  test("returns dedicated coding endpoint for zai-coding", () => {
    expect(getByokProviderBaseUrl("zai-coding")).toBe(ZAI_CODING_BASE_URL);
  });

  test("returns undefined for providers without a custom base URL", () => {
    expect(getByokProviderBaseUrl("zai")).toBeUndefined();
    expect(getByokProviderBaseUrl("anthropic")).toBeUndefined();
  });
});
