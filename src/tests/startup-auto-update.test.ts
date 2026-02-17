import { describe, expect, test } from "bun:test";
import { startStartupAutoUpdateCheck } from "../startup-auto-update";

describe("startStartupAutoUpdateCheck", () => {
  test("logs ENOTEMPTY guidance when updater returns enotemptyFailed", async () => {
    const logs: string[] = [];
    const logError = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    };

    startStartupAutoUpdateCheck(
      async () => ({ enotemptyFailed: true }),
      logError,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logs.length).toBe(2);
    expect(logs[0]).toContain("ENOTEMPTY");
    expect(logs[1]).toContain("npm i -g @letta-ai/letta-code");
  });

  test("does not throw when updater rejects", async () => {
    const logs: string[] = [];
    const logError = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    };

    startStartupAutoUpdateCheck(async () => {
      throw new Error("boom");
    }, logError);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logs.length).toBe(0);
  });

  test("does not log when updater succeeds without ENOTEMPTY", async () => {
    const logs: string[] = [];
    const logError = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    };

    startStartupAutoUpdateCheck(async () => undefined, logError);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logs.length).toBe(0);
  });
});
