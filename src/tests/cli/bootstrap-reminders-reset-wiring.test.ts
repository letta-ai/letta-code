import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("bootstrap reminder reset wiring", () => {
  test("defines helper that resets shared reminder state", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const source = readFileSync(appPath, "utf-8");

    expect(source).toContain(
      "const resetBootstrapReminderState = useCallback(() => {",
    );
    expect(source).toContain(
      "resetSharedReminderState(sharedReminderStateRef.current);",
    );
    expect(source).not.toContain("hasSentSessionContextRef.current = false;");
    expect(source).not.toContain("hasInjectedSkillsRef.current = false;");
    expect(source).not.toContain("discoveredSkillsRef.current = null;");
  });

  test("invokes helper for all conversation/agent switch entry points", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const source = readFileSync(appPath, "utf-8");

    const anchors = [
      'origin: "agent-switch"',
      'const inputCmd = "/new";', // new-agent creation flow
      'if (msg.trim() === "/new")',
      'if (msg.trim() === "/clear")',
      'origin: "resume-direct"',
      'if (action.type === "switch_conversation")', // queued conversation switch flow
      'origin: "resume-selector"',
      "onNewConversation={async () => {",
      'origin: "search"',
    ];

    for (const anchor of anchors) {
      const anchorIndex = source.indexOf(anchor);
      expect(anchorIndex).toBeGreaterThanOrEqual(0);

      const windowStart = Math.max(0, anchorIndex - 2500);
      const windowEnd = Math.min(source.length, anchorIndex + 5000);
      const scoped = source.slice(windowStart, windowEnd);
      expect(scoped).toContain("resetBootstrapReminderState();");
    }
  });

  test("new-agent creation flow resets routing to default conversation", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const source = readFileSync(appPath, "utf-8");

    const anchor = 'const inputCmd = "/new";';
    const anchorIndex = source.indexOf(anchor);
    expect(anchorIndex).toBeGreaterThanOrEqual(0);

    const windowEnd = Math.min(source.length, anchorIndex + 8000);
    const scoped = source.slice(anchorIndex, windowEnd);

    expect(scoped).toContain('const targetConversationId = "default";');
    expect(scoped).toContain("setConversationId(targetConversationId);");
    expect(scoped).toContain("settingsManager.setLocalLastSession(");
    expect(scoped).toContain("settingsManager.setGlobalLastSession({");
    expect(scoped).toContain("conversationId: targetConversationId");
  });
});
