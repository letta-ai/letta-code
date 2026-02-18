import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("headless shared reminder wiring", () => {
  test("one-shot mode builds shared reminders with system-info flag", () => {
    const headlessPath = fileURLToPath(new URL("../../headless.ts", import.meta.url));
    const source = readFileSync(headlessPath, "utf-8");

    expect(source).toContain('mode: "headless-one-shot"');
    expect(source).toContain(
      "sessionContextReminderEnabled: systemInfoReminderEnabled",
    );
  });

  test("bidirectional mode builds shared reminders with plan-mode resolver", () => {
    const headlessPath = fileURLToPath(new URL("../../headless.ts", import.meta.url));
    const source = readFileSync(headlessPath, "utf-8");

    expect(source).toContain('mode: "headless-bidirectional"');
    expect(source).toContain("resolvePlanModeReminder: async () => {");
    expect(source).toContain("const { PLAN_MODE_REMINDER } = await import");
  });

  test("all headless drains pass context tracker for compaction-driven reminder state", () => {
    const headlessPath = fileURLToPath(new URL("../../headless.ts", import.meta.url));
    const source = readFileSync(headlessPath, "utf-8");

    expect(source).toContain("syncReminderStateFromContextTracker(");
    expect(source).toContain("reminderContextTracker");
  });
});
