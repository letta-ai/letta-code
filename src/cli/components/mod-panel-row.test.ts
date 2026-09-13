import { describe, expect, test } from "bun:test";
import type { ModContext, ModPanel } from "@/cli/mods/types";
import { getPlacedModPanels, renderModPanelLines } from "./ModPanelRow";

const CONTEXT: ModContext = {
  app: { version: "0.0.0-test" },
  workspace: {
    cwd: "/tmp/project",
    currentDir: "/tmp/project/src",
    projectDir: "/tmp/project",
  },
  cwd: "/tmp/project",
  sessionId: "conv-1",
  conversationSummary: "Investigate panel context",
  lastRunId: "run-1",
  agent: { id: "agent-1", name: "Amelia" },
  model: {
    id: "openai/gpt-5.5",
    displayName: "GPT-5.5",
    provider: "openai",
    reasoningEffort: "high",
  },
  toolset: "auto",
  systemPromptId: "prompt-1",
  permissionMode: "default",
  networkPhase: null,
  terminalWidth: 80,
  contextWindow: {
    size: 200000,
    totalInputTokens: 100,
    totalOutputTokens: 20,
    usedPercentage: 0.01,
    remainingPercentage: 0.99,
    currentUsage: null,
  },
  cost: {
    totalDurationMs: 1000,
    totalApiDurationMs: 800,
    totalCostUsd: null,
    totalLinesAdded: null,
    totalLinesRemoved: null,
  },
  reflection: { mode: null, stepCount: 0 },
  memfs: { enabled: false, memoryDir: null },
  backgroundAgents: [],
  subagents: { list: () => [] },
};

function createPanel(render: ModPanel["render"]): ModPanel {
  return {
    id: "cwd",
    render,
    order: 0,
    path: "/tmp/project/.letta/mods/cwd.ts",
    updatedAt: 1,
  };
}

describe("renderModPanelLines", () => {
  test("passes the full mod context plus panel helpers", () => {
    const panel = createPanel((ctx) => {
      expect(ctx.cwd).toBe("/tmp/project");
      expect(ctx.workspace.currentDir).toBe("/tmp/project/src");
      expect(ctx.conversationSummary).toBe("Investigate panel context");
      expect(ctx.agent.name).toBe("Amelia");
      expect(ctx.model.displayName).toBe("GPT-5.5");
      expect(ctx.width).toBe(40);
      expect(typeof ctx.row).toBe("function");
      expect(typeof ctx.columns).toBe("function");
      expect(typeof ctx.link).toBe("function");
      expect(typeof ctx.chalk.dim).toBe("function");
      return ctx.row(ctx.cwd, ctx.model.displayName ?? "", ctx.width);
    });

    expect(renderModPanelLines(panel, 40, CONTEXT)).toEqual([
      "/tmp/project                     GPT-5.5",
    ]);
  });
});

describe("getPlacedModPanels", () => {
  test("treats order 1 as a singleton product-status replacement", () => {
    const panels: Record<string, ModPanel> = {
      olderProduct: {
        id: "olderProduct",
        order: 1,
        path: "/tmp/older-product.ts",
        render: () => "older",
        updatedAt: 1,
      },
      newerProduct: {
        id: "newerProduct",
        order: 1,
        path: "/tmp/newer-product.ts",
        render: () => "newer",
        updatedAt: 2,
      },
      top: {
        id: "top",
        order: 10,
        path: "/tmp/top.ts",
        render: () => "top",
        updatedAt: 1,
      },
      middle: {
        id: "middle",
        order: 2,
        path: "/tmp/middle.ts",
        render: () => "middle",
        updatedAt: 1,
      },
    };

    expect(
      getPlacedModPanels(panels, "above").map((panel) => panel.id),
    ).toEqual(["top", "middle", "newerProduct"]);
  });
});
