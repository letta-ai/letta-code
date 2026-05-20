import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("permission mode cycle order", () => {
  test("Shift+Tab includes plan only when plan mode is enabled", () => {
    const inputRichPath = fileURLToPath(
      new URL("../cli/components/InputRich.tsx", import.meta.url),
    );
    const source = readFileSync(inputRichPath, "utf-8");

    expect(source).toContain("settingsManager.isPlanModeEnabled()");
    expect(source).toContain(
      '["unrestricted", "acceptEdits", "standard", "plan"]',
    );
    expect(source).toContain('["unrestricted", "acceptEdits", "standard"]');
  });

  test("/plan-mode command is registered", () => {
    const registryPath = fileURLToPath(
      new URL("../cli/commands/registry.ts", import.meta.url),
    );
    const source = readFileSync(registryPath, "utf-8");

    expect(source).toContain('"/plan-mode": {');
    expect(source).toContain("Enable or disable plan mode (/plan-mode on|off)");
  });
});
