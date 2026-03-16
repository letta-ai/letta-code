import { describe, expect, test } from "bun:test";
import {
  DEFAULT_STATUS_LINE_DEBOUNCE_MS,
  normalizeStatusLineConfig,
} from "../../cli/helpers/statusLineConfig";
import { buildRefreshIntervalPlan } from "../../cli/hooks/useConfigurableStatusLine";

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

describe("buildRefreshIntervalPlan", () => {
  test("returns no-op when interval is unchanged", () => {
    expect(buildRefreshIntervalPlan(null, null)).toEqual({
      shouldClearExistingInterval: false,
      shouldArmInterval: false,
      nextRefreshIntervalMs: null,
    });

    expect(buildRefreshIntervalPlan(5000, 5000)).toEqual({
      shouldClearExistingInterval: false,
      shouldArmInterval: false,
      nextRefreshIntervalMs: 5000,
    });
  });

  test("arms interval when moving from off to polling", () => {
    expect(buildRefreshIntervalPlan(null, 5000)).toEqual({
      shouldClearExistingInterval: false,
      shouldArmInterval: true,
      nextRefreshIntervalMs: 5000,
    });
  });

  test("re-arms interval when polling cadence changes", () => {
    expect(buildRefreshIntervalPlan(5000, 1000)).toEqual({
      shouldClearExistingInterval: true,
      shouldArmInterval: true,
      nextRefreshIntervalMs: 1000,
    });
  });

  test("clears interval when polling is disabled", () => {
    expect(buildRefreshIntervalPlan(5000, null)).toEqual({
      shouldClearExistingInterval: true,
      shouldArmInterval: false,
      nextRefreshIntervalMs: null,
    });
  });
});
