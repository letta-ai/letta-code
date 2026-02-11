import { describe, expect, test } from "bun:test";
import {
  getStatusLineFieldsBySupport,
  STATUSLINE_FIELD_SUPPORT,
} from "../../cli/helpers/statusLineSchema";

describe("statusLineSchema", () => {
  test("contains native, derived, and unsupported groups", () => {
    const nativeFields = getStatusLineFieldsBySupport("native");
    const derivedFields = getStatusLineFieldsBySupport("derived");
    const unsupportedFields = getStatusLineFieldsBySupport("unsupported");

    expect(nativeFields.length).toBeGreaterThan(0);
    expect(derivedFields.length).toBeGreaterThan(0);
    expect(unsupportedFields.length).toBeGreaterThan(0);
  });

  test("tracks known unsupported Claude fields", () => {
    const unsupportedPaths = new Set(
      getStatusLineFieldsBySupport("unsupported").map((f) => f.path),
    );

    expect(unsupportedPaths.has("vim.mode")).toBe(true);
    expect(unsupportedPaths.has("cost.total_cost_usd")).toBe(true);
    expect(unsupportedPaths.has("transcript_path")).toBe(true);
  });

  test("field paths are unique", () => {
    const allPaths = STATUSLINE_FIELD_SUPPORT.map((f) => f.path);
    const unique = new Set(allPaths);
    expect(unique.size).toBe(allPaths.length);
  });
});
