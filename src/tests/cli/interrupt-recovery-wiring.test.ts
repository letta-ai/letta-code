import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("interrupt recovery alert wiring", () => {
  test("gates alert injection on explicit user interrupt state", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const source = readFileSync(appPath, "utf-8");

    expect(source).toContain("pendingInterruptRecoveryConversationIdRef");
    expect(source).toContain("canInjectInterruptRecovery");
    expect(source).toContain(
      "pendingInterruptRecoveryConversationIdRef.current ===",
    );
    expect(source).toContain(
      "pendingInterruptRecoveryConversationIdRef.current = null;",
    );
  });
});
