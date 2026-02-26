import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("reasoning tier cycle wiring", () => {
  test("resets pending reasoning-cycle state across context/model switches", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const source = readFileSync(appPath, "utf-8");

    expect(source).toContain(
      "const resetPendingReasoningCycle = useCallback(() => {",
    );
    expect(source).toContain("reasoningCycleDesiredRef.current = null;");
    expect(source).toContain("reasoningCycleLastConfirmedRef.current = null;");

    const resetCalls = source.match(/resetPendingReasoningCycle\(\);/g) ?? [];
    expect(resetCalls.length).toBeGreaterThanOrEqual(4);

    expect(source).toContain(
      "// Drop any pending reasoning-tier debounce before switching contexts.",
    );
    expect(source).toContain(
      "// New conversations should not inherit pending reasoning-tier debounce.",
    );
    expect(source).toContain(
      "// Clearing conversation state should also clear pending reasoning-tier debounce.",
    );
    expect(source).toContain(
      "// Switching models should discard any pending debounce from the previous model.",
    );
  });

  test("timer callbacks clear timer ref before re-flushing", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const source = readFileSync(appPath, "utf-8");

    const callbackBlocks =
      source.match(
        /reasoningCycleTimerRef\.current = setTimeout\(\(\) => \{\n {8}reasoningCycleTimerRef\.current = null;\n {8}void flushPendingReasoningEffort\(\);\n {6}\}, reasoningCycleDebounceMs\);/g,
      ) ?? [];

    expect(callbackBlocks.length).toBeGreaterThanOrEqual(2);
  });

  test("tab-based reasoning cycling is opt-in only", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const indexPath = fileURLToPath(new URL("../../index.ts", import.meta.url));
    const settingsPath = fileURLToPath(
      new URL("../../settings-manager.ts", import.meta.url),
    );

    const appSource = readFileSync(appPath, "utf-8");
    const indexSource = readFileSync(indexPath, "utf-8");
    const settingsSource = readFileSync(settingsPath, "utf-8");

    expect(settingsSource).toContain("reasoningTabCycleEnabled: boolean;");
    expect(settingsSource).toContain("reasoningTabCycleEnabled: false,");
    expect(indexSource).toContain(
      "reasoningTabCycleEnabled: settings.reasoningTabCycleEnabled === true,",
    );
    expect(appSource).toContain(
      'if (trimmed === "/reasoning-tab" || trimmed.startsWith("/reasoning-tab ")) {',
    );
    expect(appSource).toMatch(
      /onCycleReasoningEffort=\{\s*reasoningTabCycleEnabled\s*\?\s*handleCycleReasoningEffort\s*:\s*undefined\s*\}/,
    );
  });
});
