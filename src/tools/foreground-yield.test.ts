import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runWithRuntimeContext } from "@/runtime-context";
import {
  DEFAULT_FOREGROUND_YIELD_MS,
  resolveForegroundYieldMs,
} from "@/tools/foreground-yield";
import { bash } from "@/tools/impl/bash";
import { killBackgroundProcess } from "@/tools/impl/kill-bash";
import {
  clearPendingMessages,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";

describe("resolveForegroundYieldMs", () => {
  test("uses the default outside a runtime policy", () => {
    expect(resolveForegroundYieldMs()).toBe(DEFAULT_FOREGROUND_YIELD_MS);
    expect(
      runWithRuntimeContext({ foregroundYieldMs: undefined }, () =>
        resolveForegroundYieldMs(),
      ),
    ).toBe(DEFAULT_FOREGROUND_YIELD_MS);
  });

  test("uses the turn's policy value, clamped to 1-30s", () => {
    const resolve = (value: number) =>
      runWithRuntimeContext({ foregroundYieldMs: value }, () =>
        resolveForegroundYieldMs(),
      );
    expect(resolve(5_000)).toBe(5_000);
    expect(resolve(10)).toBe(1_000);
    expect(resolve(120_000)).toBe(30_000);
  });

  test("a nested turn without a policy does not inherit the outer value", () => {
    const inner = runWithRuntimeContext({ foregroundYieldMs: 2_000 }, () =>
      runWithRuntimeContext({ foregroundYieldMs: undefined }, () =>
        resolveForegroundYieldMs(),
      ),
    );
    expect(inner).toBe(DEFAULT_FOREGROUND_YIELD_MS);
  });
});

describe("Bash foreground yield", () => {
  beforeEach(() => {
    clearPendingMessages();
    setMessageQueueAdder(() => {});
  });
  afterEach(() => {
    setMessageQueueAdder(null);
    clearPendingMessages();
  });

  test("backgrounds a long command after the runtime policy's yield", async () => {
    const started = Date.now();
    const result = await runWithRuntimeContext(
      { foregroundYieldMs: 1_000 },
      () =>
        bash({
          command: `"${process.execPath}" -e "setTimeout(() => {}, 8000)"`,
          description: "Sleep",
        }),
    );
    const elapsed = Date.now() - started;
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("still running with task ID:");
    expect(elapsed).toBeLessThan(DEFAULT_FOREGROUND_YIELD_MS - 2_000);
    const bashId = text.match(/bash_\d+/)?.[0];
    if (bashId) killBackgroundProcess(bashId);
  });
});
