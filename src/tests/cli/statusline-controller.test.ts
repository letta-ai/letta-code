import { describe, expect, test } from "bun:test";
import {
  DEFAULT_STATUS_LINE_DEBOUNCE_MS,
  normalizeStatusLineConfig,
} from "../../cli/helpers/statusLineConfig";

describe("statusline controller-related config", () => {
  test("normalizes debounce and refresh interval defaults", () => {
    const normalized = normalizeStatusLineConfig({ command: "echo hi" });
    expect(normalized.debounceMs).toBe(DEFAULT_STATUS_LINE_DEBOUNCE_MS);
    expect(normalized.refreshIntervalMs).toBeUndefined();
  });

  test("keeps explicit refreshIntervalMs", () => {
    const normalized = normalizeStatusLineConfig({
      command: "echo hi",
      refreshIntervalMs: 4500,
    });
    expect(normalized.refreshIntervalMs).toBe(4500);
  });

  test("clamps padding and debounce", () => {
    const normalized = normalizeStatusLineConfig({
      command: "echo hi",
      padding: 999,
      debounceMs: 10,
    });
    expect(normalized.padding).toBe(16);
    expect(normalized.debounceMs).toBe(50);
  });
});
