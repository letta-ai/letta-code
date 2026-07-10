import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getPinnedAgentBackendMode } from "@/cli/components/AgentSelector";

describe("agent selector shortcuts", () => {
  test("uses Shift+D for delete so lowercase d can be typed in search", () => {
    const selectorPath = fileURLToPath(
      new URL("../cli/components/AgentSelector.tsx", import.meta.url),
    );
    const source = readFileSync(selectorPath, "utf-8");

    expect(source).toContain('allowDelete && input === "D"');
    expect(source).not.toContain('input === "d" || input === "D"');

    const deleteShortcutIndex = source.indexOf('allowDelete && input === "D"');
    const searchTypingIndex = source.indexOf(
      '} else if (activeTab !== "pinned" && input && !key.ctrl && !key.meta) {',
    );

    expect(deleteShortcutIndex).toBeGreaterThanOrEqual(0);
    expect(searchTypingIndex).toBeGreaterThan(deleteShortcutIndex);
    expect(source).toContain("Shift+D delete");
  });

  test("pinned agent backend comes from agent id, not pin scope", () => {
    expect(
      getPinnedAgentBackendMode(
        "agent-local-c47c57d5-72c5-4f23-baea-3fb1d441273e",
      ),
    ).toBe("local");
    expect(
      getPinnedAgentBackendMode("agent-6b383e6f-f2df-43ed-ad88-8c832f1129d0"),
    ).toBe("api");
  });

  test("keeps one spacer after tab descriptions", () => {
    const selectorPath = fileURLToPath(
      new URL("../cli/components/AgentSelector.tsx", import.meta.url),
    );
    const source = readFileSync(selectorPath, "utf-8");

    expect(source).toContain("<Box height={1} />");
    expect(source).not.toContain("<Box height={2} />");
  });

  test("supports startup fallback from empty pinned tab to Constellation", () => {
    const selectorPath = fileURLToPath(
      new URL("../cli/components/AgentSelector.tsx", import.meta.url),
    );
    const source = readFileSync(selectorPath, "utf-8");

    expect(source).toContain("initialTab?: TabId");
    expect(source).toContain("emptyPinnedFallbackTab?: TabId");
    expect(source).toContain("notice?: string");
    expect(source).toContain("useState<TabId>(initialTab)");
    expect(source).toContain('activeTab === "pinned"');
    expect(source).toContain("emptyPinnedFallbackTab");
    expect(source).toContain("validPinnedAgents.length === 0");
    expect(source).toContain("setActiveTab(fallbackTab)");
    expect(source).toContain('showNewTab && (input === "n" || input === "N")');
  });
});
