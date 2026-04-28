import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("headless telemetry exit wiring", () => {
  test("one-shot error exits route through exitHeadless", () => {
    const headlessPath = fileURLToPath(
      new URL("../../headless.ts", import.meta.url),
    );
    const source = readFileSync(headlessPath, "utf-8");

    expect(source).toContain(
      'await exitHeadless(1, "headless_max_steps_reached")',
    );
    expect(source).toContain(
      'await exitHeadless(1, "headless_requires_approval_empty")',
    );
    expect(source).toContain(
      'await exitHeadless(1, "headless_approval_resync_failed")',
    );
  });
});
