import type { ReactNode } from "react";
import type { StatusLinePayload } from "@/cli/helpers/status-line-payload";

export interface StatuslineUiContext {
  currentModelProvider: string | null;
  goalStatusText: string | null;
  hasTemporaryModelOverride: boolean;
  isByokProvider: boolean;
  isLocalBackend: boolean;
  isOpenAICodexProvider: boolean;
  rightColumnWidth: number;
}

export interface StatuslineModelContext {
  id: string | null;
  displayName: string | null;
  provider: string | null;
  reasoningEffort: string | null;
}

export interface StatuslineWorkspaceContext {
  cwd: string;
  currentDir: string;
  projectDir: string;
}

export interface StatuslineContextWindowContext {
  size: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  usedPercentage: number | null;
  remainingPercentage: number | null;
  currentUsage: StatusLinePayload["context_window"]["current_usage"];
}

export interface StatuslineCostContext {
  totalDurationMs: number;
  totalApiDurationMs: number;
  totalCostUsd: number | null;
  totalLinesAdded: number | null;
  totalLinesRemoved: number | null;
}

export interface StatuslineRenderContext {
  rawPayload: StatusLinePayload;
  app: {
    version: string;
  };
  workspace: StatuslineWorkspaceContext;
  cwd: string;
  sessionId: string | null;
  lastRunId: string | null;
  agent: StatusLinePayload["agent"];
  model: StatuslineModelContext;
  toolset: string | null;
  systemPromptId: string | null;
  permissionMode: string | null;
  networkPhase: StatusLinePayload["network_phase"];
  terminalWidth: number | null;
  contextWindow: StatuslineContextWindowContext;
  cost: StatuslineCostContext;
  reflection: StatusLinePayload["reflection"];
  memfs: StatusLinePayload["memfs"];
  backgroundAgents: StatusLinePayload["background_agents"];
  ui: StatuslineUiContext;
}

export type StatuslineRendererOutput = ReactNode | null;

export interface StatuslineRenderer {
  id: string;
  label: string;
  description: string;
  render: (context: StatuslineRenderContext) => StatuslineRendererOutput;
}
