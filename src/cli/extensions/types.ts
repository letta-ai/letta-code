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

export interface ExtensionTokenUsageContext {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
}

export interface ExtensionContextWindowContext {
  size: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  usedPercentage: number | null;
  remainingPercentage: number | null;
  currentUsage: ExtensionTokenUsageContext | null;
}

export interface ExtensionCostContext {
  totalDurationMs: number;
  totalApiDurationMs: number;
  totalCostUsd: number | null;
  totalLinesAdded: number | null;
  totalLinesRemoved: number | null;
}

export interface ExtensionAgentContext {
  id: string | null;
  name: string | null;
}

export interface ExtensionReflectionContext {
  mode: "off" | "step-count" | "compaction-event" | null;
  stepCount: number;
}

export interface ExtensionMemfsContext {
  enabled: boolean;
  memoryDir: string | null;
}

export interface ExtensionBackgroundAgentContext {
  type: string;
  status: string;
  durationMs: number;
}

export interface ExtensionContext {
  app: {
    version: string;
  };
  workspace: ExtensionWorkspaceContext;
  cwd: string;
  sessionId: string | null;
  lastRunId: string | null;
  agent: ExtensionAgentContext;
  model: ExtensionModelContext;
  toolset: string | null;
  systemPromptId: string | null;
  permissionMode: string | null;
  networkPhase: "upload" | "download" | "error" | null;
  terminalWidth: number | null;
  contextWindow: ExtensionContextWindowContext;
  cost: ExtensionCostContext;
  reflection: ExtensionReflectionContext;
  memfs: ExtensionMemfsContext;
  backgroundAgents: ExtensionBackgroundAgentContext[];
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

export type ExtensionPanelContent = string | string[];

export interface ExtensionPanelOptions {
  content?: ExtensionPanelContent;
  id: string;
  order?: number;
}

export interface ExtensionPanelUpdate {
  content?: ExtensionPanelContent;
  order?: number;
}

export interface ExtensionPanel {
  content: string[];
  id: string;
  order: number;
  path: string;
  updatedAt: number;
}

export interface ExtensionPanelHandle {
  close: () => void;
  update: (update: ExtensionPanelUpdate) => void;
}

export interface ExtensionCommandRegistration {
  id: string;
  description: string;
  args?: string;
  order?: number;
  override?: boolean;
  runWhenBusy?: boolean;
  showInTranscript?: boolean;
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
  runWhenBusy: boolean;
  showInTranscript: boolean;
  run: ExtensionCommandRegistration["run"];
}
