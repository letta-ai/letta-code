import { describe, expect, test } from "bun:test";

import { getDefaultModel, getDefaultModelForTier } from "../../agent/model";

describe("getDefaultModelForTier", () => {
  test("returns the default model for free tier", () => {
    expect(getDefaultModelForTier("free")).toBe(getDefaultModel());
  });

  test("is case-insensitive for free tier", () => {
    expect(getDefaultModelForTier("FrEe")).toBe(getDefaultModel());
  });

  test("returns standard default for non-free tiers", () => {
    expect(getDefaultModelForTier("pro")).toBe(getDefaultModel());
    expect(getDefaultModelForTier("enterprise")).toBe(getDefaultModel());
    expect(getDefaultModelForTier(null)).toBe(getDefaultModel());
  });
});
