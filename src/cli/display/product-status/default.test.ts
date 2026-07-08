import { describe, expect, test } from "bun:test";
import stripAnsi from "strip-ansi";
import { renderModPanelLines } from "@/cli/components/ModPanelRow";
import type { ModContext } from "@/cli/mods/types";
import {
  createDefaultProductStatusPanel,
  defaultProductStatusPanel,
  withDefaultProductStatusPanel,
} from "./default";

function createContext({
  backgroundAgents = [],
  subagents = { list: () => [] },
}: {
  backgroundAgents?: ModContext["backgroundAgents"];
  subagents?: ModContext["subagents"];
} = {}): ModContext {
  return {
    app: { version: "0.0.0-test" },
    workspace: {
      cwd: "/tmp/project",
      currentDir: "/tmp/project",
      projectDir: "/tmp/project",
    },
    cwd: "/tmp/project",
    sessionId: "conv-1",
    conversationSummary: null,
    lastRunId: null,
    agent: { id: "agent-1", name: "Amelia" },
    model: {
      id: "openai/gpt-5.5",
      displayName: "GPT-5.5",
      provider: "openai",
      reasoningEffort: null,
    },
    toolset: "auto",
    systemPromptId: null,
    permissionMode: "default",
    networkPhase: null,
    terminalWidth: 80,
    contextWindow: {
      size: 200000,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      usedPercentage: null,
      remainingPercentage: null,
      currentUsage: null,
    },
    cost: {
      totalDurationMs: 0,
      totalApiDurationMs: 0,
      totalCostUsd: null,
      totalLinesAdded: null,
      totalLinesRemoved: null,
    },
    reflection: { mode: null, stepCount: 0 },
    memfs: { enabled: false, memoryDir: null },
    backgroundAgents,
    subagents,
  };
}

describe("defaultProductStatusPanel", () => {
  test("renders active background reflection with compact label", () => {
    const agentUrl = "https://chat.letta.com/agents/agent-reflection";
    const lines = renderModPanelLines(
      defaultProductStatusPanel,
      80,
      createContext({
        backgroundAgents: [
          {
            type: "Reflection",
            status: "running",
            durationMs: 65_000,
            agentId: "agent-reflection",
          },
        ],
        subagents: {
          list: () => [
            {
              id: "sub-reflection",
              type: "Reflection",
              description: "Dream about memory",
              status: "running",
              agentId: "agent-reflection",
              agentUrl,
              startedAtMs: Date.now() - 65_000,
              elapsedMs: 65_000,
              isBackground: true,
              visibleInTranscript: false,
            },
          ],
        },
      }),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(agentUrl);
    expect(stripAnsi(lines[0] ?? "").trim()).toBe("⠋ dreaming (65s)");
  });

  test("does not render inactive background reflection", () => {
    const lines = renderModPanelLines(
      defaultProductStatusPanel,
      80,
      createContext({
        backgroundAgents: [
          {
            type: "Reflection",
            status: "completed",
            durationMs: 65_000,
            agentId: null,
          },
        ],
      }),
    );

    expect(lines).toEqual([]);
  });

  test("renders non-reflection background agents with raw type label", () => {
    const lines = renderModPanelLines(
      defaultProductStatusPanel,
      80,
      createContext({
        backgroundAgents: [
          {
            type: "general-purpose",
            status: "running",
            durationMs: 65_000,
            agentId: null,
          },
        ],
      }),
    );

    expect(stripAnsi(lines[0] ?? "").trim()).toBe("⠋ general-purpose (65s)");
  });

  test("renders clickable link when agentUrl is provided and not tmux", () => {
    const agentUrl = "https://app.letta.com/chat/agent-reflection";
    const panel = createDefaultProductStatusPanel({ agentUrl });
    const lines = renderModPanelLines(
      panel,
      80,
      createContext({
        backgroundAgents: [
          {
            type: "Reflection",
            status: "running",
            durationMs: 65_000,
            agentId: "agent-reflection",
          },
        ],
      }),
    );

    expect(lines).toHaveLength(1);
    // OSC-8 escape sequence should be present (clickable link)
    expect(lines[0]).toContain(agentUrl);
    // Should not render the URL as visible text
    expect(stripAnsi(lines[0] ?? "").trim()).toBe("⠋ dreaming (65s)");
  });

  test("does not render URL as plain text in tmux", () => {
    const agentUrl = "https://app.letta.com/chat/agent-reflection";
    const originalTmux = process.env.TMUX;
    process.env.TMUX = "1";
    try {
      const panel = createDefaultProductStatusPanel({ agentUrl });
      const lines = renderModPanelLines(
        panel,
        80,
        createContext({
          backgroundAgents: [
            {
              type: "Reflection",
              status: "running",
              durationMs: 65_000,
              agentId: "agent-reflection",
            },
          ],
        }),
      );

      expect(lines).toHaveLength(1);
      // No URL in the output at all (not even in escape sequences)
      expect(lines[0]).not.toContain(agentUrl);
      expect(stripAnsi(lines[0] ?? "").trim()).toBe("⠋ dreaming (65s)");
    } finally {
      if (originalTmux === undefined) {
        delete process.env.TMUX;
      } else {
        process.env.TMUX = originalTmux;
      }
    }
  });
});

describe("product status panel ordering", () => {
  test("injects default product status panel when order 1 is unclaimed", () => {
    const panels = {
      additive: {
        id: "additive",
        order: 2,
        path: "/tmp/additive.ts",
        updatedAt: 1,
        render: () => "additive",
      },
    };

    expect(Object.keys(withDefaultProductStatusPanel(panels))).toEqual([
      "additive",
      "default:dreaming",
    ]);
  });

  test("does not inject default product status panel when order 1 is claimed", () => {
    const panels = {
      product: {
        id: "product",
        order: 1,
        path: "/tmp/product.ts",
        updatedAt: 2,
        render: () => "product",
      },
      additive: {
        id: "additive",
        order: 2,
        path: "/tmp/additive.ts",
        updatedAt: 1,
        render: () => "additive",
      },
    };

    expect(Object.keys(withDefaultProductStatusPanel(panels))).toEqual([
      "product",
      "additive",
    ]);
  });
});
