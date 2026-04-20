import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const appPath = fileURLToPath(new URL("../../cli/App.tsx", import.meta.url));

describe("conversation switch ref wiring", () => {
  test("defines helper that syncs conversation state and ref", () => {
    const source = readFileSync(appPath, "utf-8");

    expect(source).toContain(
      "const setConversationIdAndRef = useCallback((nextConversationId: string) => {",
    );
    expect(source).toContain("conversationIdRef.current = nextConversationId;");
    expect(source).toContain("setConversationId(nextConversationId);");
  });

  test("uses the synced helper for conversation switch entry points", () => {
    const source = readFileSync(appPath, "utf-8");

    const anchors = [
      'origin: "fork"',
      'origin: "agent-switch"',
      "const newMatch = msg.trim().match(/^\\/new(?:\\s+(.+))?$/);",
      'if (msg.trim() === "/clear")',
      'origin: "resume-direct"',
      'if (action.type === "switch_conversation")',
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
      expect(scoped).toContain("setConversationIdAndRef(");
    }

    expect(source.match(/\bsetConversationId\(/g)?.length).toBe(1);
  });

  test("builds shared reminder parts from the live conversation ref", () => {
    const source = readFileSync(appPath, "utf-8");

    expect(source).toContain("conversationId: conversationIdRef.current,");
  });
});
