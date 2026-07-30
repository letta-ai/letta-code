import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AGENT_SELECTOR_TABS,
  getVisibleAgentSelectorTabs,
} from "@/cli/components/agent-selector-utils";
import { getPinnedAgentBackendMode } from "@/cli/helpers/pinned-agent-listing";

describe("agent selector shortcuts", () => {
  test("uses Shift+D for delete so lowercase d can be typed in search", () => {
    const selectorPath = fileURLToPath(
      new URL("../cli/components/AgentSelector.tsx", import.meta.url),
    );
    const footerPath = fileURLToPath(
      new URL("../cli/components/AgentSelectorFooter.tsx", import.meta.url),
    );
    const source = readFileSync(selectorPath, "utf-8");
    const footerSource = readFileSync(footerPath, "utf-8");

    expect(source).toContain('allowDelete && input === "D"');
    expect(source).not.toContain('input === "d" || input === "D"');

    const deleteShortcutIndex = source.indexOf('allowDelete && input === "D"');
    const searchTypingIndex = source.indexOf(
      '} else if (activeTab !== "pinned" && input && !key.ctrl && !key.meta) {',
    );

    expect(deleteShortcutIndex).toBeGreaterThanOrEqual(0);
    expect(searchTypingIndex).toBeGreaterThan(deleteShortcutIndex);
    expect(footerSource).toContain("Shift+D delete");
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

  test("includes a shared-with-me tab", () => {
    expect(AGENT_SELECTOR_TABS.map((tab) => tab.id)).toContain("shared");
  });

  test("hides the shared-with-me tab without cloud auth", () => {
    const visibleTabs = getVisibleAgentSelectorTabs({
      showNewTab: true,
      hasLocalAgents: true,
      hasCloudAuth: false,
    });

    expect(visibleTabs.map((tab) => tab.id)).not.toContain("shared");
  });

  test("keeps one spacer after tab descriptions", () => {
    const selectorPath = fileURLToPath(
      new URL("../cli/components/AgentSelector.tsx", import.meta.url),
    );
    const source = readFileSync(selectorPath, "utf-8");

    expect(source).toContain("<Box height={1} />");
    expect(source).not.toContain("<Box height={2} />");
  });
});
