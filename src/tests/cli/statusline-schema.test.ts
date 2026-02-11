import { describe, expect, test } from "bun:test";
import {
  STATUSLINE_DERIVED_FIELDS,
  STATUSLINE_NATIVE_FIELDS,
} from "../../cli/helpers/statusLineSchema";

describe("statusLineSchema", () => {
  test("contains native and derived fields", () => {
    expect(STATUSLINE_NATIVE_FIELDS.length).toBeGreaterThan(0);
    expect(STATUSLINE_DERIVED_FIELDS.length).toBeGreaterThan(0);
  });

  test("field paths are unique", () => {
    const allPaths = [
      ...STATUSLINE_NATIVE_FIELDS,
      ...STATUSLINE_DERIVED_FIELDS,
    ].map((f) => f.path);
    const unique = new Set(allPaths);
    expect(unique.size).toBe(allPaths.length);
  });
});
