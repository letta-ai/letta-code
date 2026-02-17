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

  test("resets trajectory bases in tool-interrupt eager-cancel branch", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const source = readFileSync(appPath, "utf-8");

    const start = source.indexOf("if (\n      isExecutingTool");
    const end = source.indexOf("if (!streaming || interruptRequested)");

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);
    expect(segment).toContain("setStreaming(false);");
    expect(segment).toContain("resetTrajectoryBases();");
  });

  test("resets trajectory bases in regular eager-cancel branch", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const source = readFileSync(appPath, "utf-8");

    const start = source.indexOf("if (EAGER_CANCEL) {");
    const end = source.indexOf("} else {\n      setInterruptRequested(true);");

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);
    expect(segment).toContain("setStreaming(false);");
    expect(segment).toContain("resetTrajectoryBases();");
  });

  test("includes resetTrajectoryBases in handleInterrupt dependency array", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const source = readFileSync(appPath, "utf-8");

    const start = source.indexOf(
      "const handleInterrupt = useCallback(async () => {",
    );
    const end = source.indexOf(
      "const processConversationRef = useRef(processConversation);",
    );

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);
    expect(segment).toContain("resetTrajectoryBases,");
  });
});
