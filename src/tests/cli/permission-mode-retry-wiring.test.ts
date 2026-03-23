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

    const start = source.indexOf("const setUiPermissionMode = useCallback(");
    const end = source.indexOf(
      "const statusLineTriggerVersionRef = useRef(0);",
      start,
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);
    expect(segment).toContain("if (permissionMode.getMode() !== mode)");
    expect(segment).toContain(
      'if (mode === "plan" && !permissionMode.getPlanFilePath())',
    );
    expect(segment).toContain("permissionMode.setPlanFilePath(planPath);");
    expect(segment).toContain("cacheLastPlanFilePath(planPath);");
    expect(segment).toContain("permissionMode.setMode(mode);");
  });

  test("caches the plan path at every plan-mode entry point", () => {
    const source = readAppSource();

    expect(source).toContain(
      "const cacheLastPlanFilePath = useCallback((planFilePath: string | null) => {",
    );

    const slashPlanStart = source.indexOf('if (trimmed === "/plan") {');
    const slashPlanEnd = source.indexOf(
      "return { submitted: true };",
      slashPlanStart,
    );
    expect(slashPlanStart).toBeGreaterThan(-1);
    expect(slashPlanEnd).toBeGreaterThan(slashPlanStart);
    expect(source.slice(slashPlanStart, slashPlanEnd)).toContain(
      "cacheLastPlanFilePath(planPath);",
    );

    const modeChangeStart = source.indexOf(
      "const handlePermissionModeChange = useCallback(",
    );
    const modeChangeEnd = source.indexOf(
      "// Reasoning tier cycling (Tab hotkey in InputRich.tsx)",
    );
    expect(modeChangeStart).toBeGreaterThan(-1);
    expect(modeChangeEnd).toBeGreaterThan(modeChangeStart);
    expect(source.slice(modeChangeStart, modeChangeEnd)).toContain(
      "cacheLastPlanFilePath(planPath);",
    );

    const enterPlanStart = source.indexOf(
      "const handleEnterPlanModeApprove = useCallback(",
    );
    const enterPlanEnd = source.indexOf(
      "const handleEnterPlanModeReject = useCallback(async () => {",
    );
    expect(enterPlanStart).toBeGreaterThan(-1);
    expect(enterPlanEnd).toBeGreaterThan(enterPlanStart);
    expect(source.slice(enterPlanStart, enterPlanEnd)).toContain(
      "cacheLastPlanFilePath(planFilePath);",
    );
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

  test("handleEnterPlanModeApprove supports preserveMode to stay in YOLO", () => {
    const source = readAppSource();

    const start = source.indexOf(
      "const handleEnterPlanModeApprove = useCallback(",
    );
    const end = source.indexOf(
      "const handleEnterPlanModeReject = useCallback(async () => {",
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);
    expect(segment).toContain("preserveMode: boolean = false");
    expect(segment).toContain("if (!preserveMode)");
    expect(segment).toContain('permissionMode.setMode("plan")');
  });

  test("auto-approves EnterPlanMode in bypassPermissions mode", () => {
    const source = readAppSource();

    const guardStart = source.indexOf("Guard EnterPlanMode:");
    expect(guardStart).toBeGreaterThan(-1);

    const guardEnd = source.indexOf(
      "// Live area shows only in-progress items",
      guardStart,
    );
    expect(guardEnd).toBeGreaterThan(guardStart);

    const segment = source.slice(guardStart, guardEnd);
    expect(segment).toContain('approval?.toolName === "EnterPlanMode"');
    expect(segment).toContain(
      'permissionMode.getMode() === "bypassPermissions"',
    );
    expect(segment).toContain("handleEnterPlanModeApprove(true)");
  });

  test("preserves saved plan path when approving ExitPlanMode after mode cycling", () => {
    const source = readAppSource();

    const start = source.indexOf("const handlePlanApprove = useCallback(");
    const end = source.indexOf(
      "useEffect(() => {\n    const currentIndex = approvalResults.length;",
      start,
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);
    expect(segment).toContain(
      "permissionMode.getPlanFilePath() ?? lastPlanFilePathRef.current",
    );
    expect(segment).toContain("if (planFilePath) {");
    expect(segment).toContain("lastPlanFilePathRef.current = planFilePath;");
  });

  test("restores bypassPermissions when it was active before plan approval", () => {
    const source = readAppSource();

    const start = source.indexOf("const handlePlanApprove = useCallback(");
    const end = source.indexOf(
      "useEffect(() => {\n    const currentIndex = approvalResults.length;",
      start,
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);
    expect(segment).toContain(
      "const previousMode = permissionMode.getModeBeforePlan();",
    );
    expect(segment).toContain('previousMode === "bypassPermissions"');
    expect(segment).toContain('"bypassPermissions"');
  });

  test("does not auto-approve ExitPlanMode in bypassPermissions mode", () => {
    const source = readAppSource();

    const guardStart = source.indexOf("Guard ExitPlanMode:");
    expect(guardStart).toBeGreaterThan(-1);

    const guardEnd = source.indexOf(
      "const handleQuestionSubmit = useCallback(",
    );
    expect(guardEnd).toBeGreaterThan(guardStart);

    const segment = source.slice(guardStart, guardEnd);
    const modeGuardStart = segment.indexOf('if (mode !== "plan") {');
    const modeGuardEnd = segment.indexOf(
      "// Plan mode state was lost and no plan file is recoverable",
    );
    expect(modeGuardStart).toBeGreaterThan(-1);
    expect(modeGuardEnd).toBeGreaterThan(modeGuardStart);

    const modeGuard = segment.slice(modeGuardStart, modeGuardEnd);
    expect(modeGuard).toContain("if (hasUsablePlan) {");
    expect(modeGuard).toContain("let user manually approve");
    expect(modeGuard).not.toContain("handlePlanApprove()");
  });
});
