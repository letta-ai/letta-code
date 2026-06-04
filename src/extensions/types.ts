import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaStreamingResponse,
  Message,
} from "@letta-ai/letta-client/resources/agents/messages";

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

export interface ExtensionUiCapabilities {
  panels: boolean;
  statusValues: boolean;
  customStatuslineRenderer: boolean;
}

export interface ExtensionEventCapabilities {
  lifecycle: boolean;
  tools: boolean;
  turns: boolean;
}

export interface ExtensionCapabilities {
  tools: boolean;
  commands: boolean;
  events: ExtensionEventCapabilities;
  providers: boolean;
  ui: ExtensionUiCapabilities;
}

export interface ExtensionConversationForkOptions {
  hidden?: boolean;
}

export type ExtensionConversationMessage = MessageCreate | ApprovalCreate;

export interface ExtensionConversationSendMessageOptions {
  background?: boolean;
  overrideModel?: string;
  skipImageNormalization?: boolean;
  streamTokens?: boolean;
  workingDirectory?: string;
}

export interface ExtensionConversationSendMessageRequestOptions {
  headers?: Record<string, string>;
  maxRetries?: number;
  signal?: AbortSignal;
}

export interface ExtensionConversationHistoryOptions {
  /** Maximum number of recent messages to return. Defaults to 100. */
  limit?: number;
  /** Return chronological (asc, default) or newest-first (desc) messages. */
  order?: "asc" | "desc";
  /** Include error messages and error statuses. Defaults to true. */
  includeErrors?: boolean;
}

export interface ExtensionConversationHandle {
  id: string | null;
  fork: (
    options?: ExtensionConversationForkOptions,
  ) => Promise<ExtensionConversationHandle>;
  getHistory: (
    options?: ExtensionConversationHistoryOptions,
  ) => Promise<Message[]>;
  sendMessageStream: (
    messages: ExtensionConversationMessage[],
    options?: ExtensionConversationSendMessageOptions,
    requestOptions?: ExtensionConversationSendMessageRequestOptions,
  ) => Promise<AsyncIterable<LettaStreamingResponse>>;
}

export type ExtensionSourceScope = "global" | "project" | "bundled";

export interface ExtensionOwner {
  id: string;
  path: string;
  scope: ExtensionSourceScope;
  generation: number;
}

export type ExtensionEventName =
  | "conversation_open"
  | "conversation_close"
  | "tool_start"
  | "turn_start";

export type ExtensionConversationOpenReason =
  | "startup"
  | "new"
  | "resume"
  | "fork";

export type ExtensionConversationCloseReason =
  | "quit"
  | "new"
  | "resume"
  | "fork";

export interface ExtensionConversationOpenEvent {
  agentId: string | null;
  agentName: string | null;
  conversationId: string | null;
  previousConversationId?: string | null;
  reason: ExtensionConversationOpenReason;
}

export interface ExtensionConversationCloseEvent {
  agentId: string | null;
  conversationId: string | null;
  durationMs: number | null;
  messageCount: number | null;
  reason: ExtensionConversationCloseReason;
  toolCallCount: number | null;
}

export interface ExtensionTurnStartEvent {
  agentId: string | null;
  conversationId: string | null;
  input: Array<MessageCreate | ApprovalCreate>;
}

export interface ExtensionTurnStartResult {
  input?: Array<MessageCreate | ApprovalCreate>;
}

export interface ExtensionToolStartEvent {
  agentId: string | null;
  conversationId: string | null;
  toolCallId: string | null;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ExtensionToolStartResult {
  args?: Record<string, unknown>;
  /** If true, the tool execution is denied. All handlers still run, but any denial blocks the tool. */
  deny?: boolean;
  /** Human-readable reason for the denial. Shown to the model as the tool error message. */
  reason?: string;
}

export interface ExtensionEventMap {
  conversation_open: ExtensionConversationOpenEvent;
  conversation_close: ExtensionConversationCloseEvent;
  tool_start: ExtensionToolStartEvent;
  turn_start: ExtensionTurnStartEvent;
}

export interface ExtensionEventResultMap {
  conversation_open: undefined;
  conversation_close: undefined;
  tool_start: ExtensionToolStartResult | undefined;
  turn_start: ExtensionTurnStartResult | undefined;
}

export interface ExtensionEventContext {
  conversation: ExtensionConversationHandle;
  context: ExtensionContext;
  getContext: () => ExtensionContext;
  signal: AbortSignal;
}

export type ExtensionEventHandler<
  TName extends ExtensionEventName = ExtensionEventName,
> = (
  event: ExtensionEventMap[TName],
  context: ExtensionEventContext,
) => ExtensionEventResultMap[TName] | Promise<ExtensionEventResultMap[TName]>;

export interface ExtensionEventRegistration<
  TName extends ExtensionEventName = ExtensionEventName,
> {
  handler: ExtensionEventHandler<TName>;
  name: TName;
  owner?: ExtensionOwner;
  path: string;
}

export interface ExtensionEventEmissionResult<
  TName extends ExtensionEventName = ExtensionEventName,
> {
  diagnostics: ExtensionDiagnostic[];
  handlerCount: number;
  name: TName;
  results: Array<NonNullable<ExtensionEventResultMap[TName]>>;
}

export type ExtensionCapabilityKind =
  | "command"
  | "event"
  | "provider"
  | "tool"
  | "panel"
  | "status"
  | "statusline";

export interface ExtensionCapabilityRecord<T> {
  id: string;
  kind: ExtensionCapabilityKind;
  owner: ExtensionOwner;
  value: T;
  createdAt: number;
}

export type ExtensionDiagnosticPhase =
  | "transpile"
  | "import"
  | "activate"
  | "command.override"
  | "dispose"
  | "event"
  | "stale_handle"
  | "status.evaluate";

export interface ExtensionDiagnostic {
  capability?: {
    id: string;
    kind: ExtensionCapabilityKind;
  };
  error: Error;
  owner?: ExtensionOwner;
  path?: string;
  phase: ExtensionDiagnosticPhase;
  timestamp: number;
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
  conversation: ExtensionConversationHandle & { id: string };
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
  owner?: ExtensionOwner;
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
  owner?: ExtensionOwner;
  order: number;
  path: string;
  runWhenBusy: boolean;
  showInTranscript: boolean;
  run: ExtensionCommandRegistration["run"];
}

export interface ExtensionToolContentText {
  type: "text";
  text: string;
}

export interface ExtensionToolContentImage {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export type ExtensionToolContent =
  | ExtensionToolContentText
  | ExtensionToolContentImage;

export type ExtensionToolRunResult =
  | string
  | ExtensionToolContent[]
  | {
      content?: string | ExtensionToolContent[];
      output?: string;
      stdout?: string[];
      stderr?: string[];
      status?: "success" | "error";
      isError?: boolean;
      success?: boolean;
    };

export interface ExtensionToolRunContext {
  args: Record<string, unknown>;
  cwd: string;
  workingDirectory: string;
  toolCallId: string | null;
  signal: AbortSignal;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  permissionMode: string | null;
  agent: {
    id: string | null;
  };
  conversation: ExtensionConversationHandle;
  getContext: () => ExtensionContext;
}

export interface ExtensionToolRegistration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  override?: boolean;
  requiresApproval?: boolean;
  parallelSafe?: boolean;
  isEnabled?: (context: ExtensionContext) => boolean;
  run: (
    context: ExtensionToolRunContext,
  ) => ExtensionToolRunResult | Promise<ExtensionToolRunResult>;
}

export interface ExtensionTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  owner?: ExtensionOwner;
  path: string;
  requiresApproval: boolean;
  parallelSafe: boolean;
  isEnabled?: ExtensionToolRegistration["isEnabled"];
  run: ExtensionToolRegistration["run"];
}
