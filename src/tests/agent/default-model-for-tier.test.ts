import { describe, expect, test } from "bun:test";

import { getDefaultModel, getDefaultModelForTier } from "../../agent/model";

describe("getDefaultModelForTier", () => {
  test("returns GLM-5 for free tier", () => {
    expect(getDefaultModelForTier("free")).toBe("zai/glm-5");
  });

  test("is case-insensitive for free tier", () => {
    expect(getDefaultModelForTier("FrEe")).toBe("zai/glm-5");
  });

  test("returns standard default for non-free tiers", () => {
    expect(getDefaultModelForTier("pro")).toBe(getDefaultModel());
    expect(getDefaultModelForTier("enterprise")).toBe(getDefaultModel());
    expect(getDefaultModelForTier(null)).toBe(getDefaultModel());
  });
});
