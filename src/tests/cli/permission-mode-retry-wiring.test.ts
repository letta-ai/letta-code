import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readAppSource(): string {
  const appPath = fileURLToPath(new URL("../../cli/App.tsx", import.meta.url));
  return readFileSync(appPath, "utf-8");
}

describe("permission mode retry wiring", () => {
  test("setUiPermissionMode syncs singleton mode immediately", () => {
    const source = readAppSource();

    const start = source.indexOf(
      "const setUiPermissionMode = useCallback((mode: PermissionMode) => {",
    );
    const end = source.indexOf(
      "const statusLineTriggerVersionRef = useRef(0);",
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);
    expect(segment).toContain("if (permissionMode.getMode() !== mode)");
    expect(segment).toContain(
      'if (mode === "plan" && !permissionMode.getPlanFilePath())',
    );
    expect(segment).toContain("permissionMode.setPlanFilePath(planPath);");
    expect(segment).toContain("permissionMode.setMode(mode);");
  });

  test("pins submission permission mode and defines a restore helper", () => {
    const source = readAppSource();

    const processStart = source.indexOf(
      "const processConversation = useCallback(",
    );
    const processEnd = source.indexOf("const handleExit = useCallback(");
    expect(processStart).toBeGreaterThan(-1);
    expect(processEnd).toBeGreaterThan(processStart);

    const segment = source.slice(processStart, processEnd);
    expect(segment).toContain(
      "const pinnedPermissionMode = uiPermissionModeRef.current;",
    );
    expect(segment).toContain("const restorePinnedPermissionMode = () => {");
    expect(segment).toContain('if (pinnedPermissionMode === "plan") return;');
    expect(segment).toContain(
      "if (permissionMode.getMode() !== pinnedPermissionMode)",
    );
    expect(segment).toContain(
      "if (uiPermissionModeRef.current !== pinnedPermissionMode)",
    );
  });

  test("restores pinned mode before continuing conversation-busy retries", () => {
    const source = readAppSource();

    const start = source.indexOf(
      'if (preStreamAction === "retry_conversation_busy") {',
    );
    const end = source.indexOf(
      "// Retry pre-stream transient errors (429/5xx/network) with shared LLM retry budget",
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);
    expect(segment).toContain("restorePinnedPermissionMode();");
    expect(segment).toContain("buffersRef.current.interrupted = false;");
    expect(segment).toContain("continue;");
  });

  test("restores pinned mode before continuing transient retries", () => {
    const source = readAppSource();

    const start = source.indexOf(
      'if (preStreamAction === "retry_transient") {',
    );
    const end = source.indexOf(
      "// Reset conversation busy retry counter on non-busy error",
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);
    expect(segment).toContain("restorePinnedPermissionMode();");
    expect(segment).toContain("buffersRef.current.interrupted = false;");
    expect(segment).toContain("conversationBusyRetriesRef.current = 0;");
    expect(segment).toContain("continue;");
  });
});
