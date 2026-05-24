import type { StatusLinePayload } from "@/cli/helpers/status-line-payload";

export interface ExtensionWorkspaceContext {
  cwd: string;
  currentDir: string;
  projectDir: string;
}

export interface ExtensionModelContext {
  id: string | null;
  displayName: string | null;
  provider: string | null;
  reasoningEffort: string | null;
}

export interface ExtensionContextWindowContext {
  size: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  usedPercentage: number | null;
  remainingPercentage: number | null;
  currentUsage: StatusLinePayload["context_window"]["current_usage"];
}

export interface ExtensionCostContext {
  totalDurationMs: number;
  totalApiDurationMs: number;
  totalCostUsd: number | null;
  totalLinesAdded: number | null;
  totalLinesRemoved: number | null;
}

export interface ExtensionContext {
  app: {
    version: string;
  };
  workspace: ExtensionWorkspaceContext;
  cwd: string;
  sessionId: string | null;
  lastRunId: string | null;
  agent: StatusLinePayload["agent"];
  model: ExtensionModelContext;
  toolset: string | null;
  systemPromptId: string | null;
  permissionMode: string | null;
  networkPhase: StatusLinePayload["network_phase"];
  terminalWidth: number | null;
  contextWindow: ExtensionContextWindowContext;
  cost: ExtensionCostContext;
  reflection: StatusLinePayload["reflection"];
  memfs: StatusLinePayload["memfs"];
  backgroundAgents: StatusLinePayload["background_agents"];
}

export interface ExtensionCommandContext {
  rawInput: string;
  command: string;
  args: string;
  argv: string[];
  cwd: string;
  agent: {
    id: string;
    name: string | null;
  };
  conversation: {
    id: string;
  };
  model: {
    id: string | null;
    displayName: string | null;
  };
  permissionMode: string | null;
  getContext: () => ExtensionContext;
}

export type ExtensionCommandResult =
  | { type: "prompt"; content: string; systemReminder?: boolean }
  | { type: "output"; output: string; success?: boolean }
  | { type: "handled" };

export interface ExtensionCommandRegistration {
  id: string;
  description: string;
  args?: string;
  order?: number;
  override?: boolean;
  run: (
    context: ExtensionCommandContext,
  ) => ExtensionCommandResult | Promise<ExtensionCommandResult>;
}

export interface ExtensionCommand {
  id: string;
  description: string;
  args?: string;
  order: number;
  path: string;
  run: ExtensionCommandRegistration["run"];
}
