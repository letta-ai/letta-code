import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("permission mode cycle order", () => {
  test("Shift+Tab includes plan only when plan mode is enabled", () => {
    const inputRichPath = fileURLToPath(
      new URL("../../cli/components/InputRich.tsx", import.meta.url),
    );
    const source = readFileSync(inputRichPath, "utf-8");

    expect(source).toContain("settingsManager.isPlanModeEnabled()");
    expect(source).toContain(
      '["default", "plan", "acceptEdits", "bypassPermissions"]',
    );
    expect(source).toContain('["default", "acceptEdits", "bypassPermissions"]');
  });
});
