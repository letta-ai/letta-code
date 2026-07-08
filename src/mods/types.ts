import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaStreamingResponse,
  Message,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { ChalkInstance } from "chalk";
import type { ModelReasoningEffort } from "@/agent/model";
import type { SubagentLifecycleContext } from "@/agent/subagent-state";

export interface ModWorkspaceContext {
  cwd: string;
  currentDir: string;
  projectDir: string;
}

export interface ModModelContext {
  id: string | null;
  displayName: string | null;
  provider: string | null;
  reasoningEffort: string | null;
}

export interface ModTokenUsageContext {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
}

export interface ModContextWindowContext {
  size: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  usedPercentage: number | null;
  remainingPercentage: number | null;
  currentUsage: ModTokenUsageContext | null;
}

export interface ModCostContext {
  totalDurationMs: number;
  totalApiDurationMs: number;
  totalCostUsd: number | null;
  totalLinesAdded: number | null;
  totalLinesRemoved: number | null;
}

export interface ModAgentContext {
  id: string | null;
  name: string | null;
}

export interface ModReflectionContext {
  mode: "off" | "step-count" | "compaction-event" | null;
  stepCount: number;
}

export interface ModMemfsContext {
  enabled: boolean;
  memoryDir: string | null;
}

export interface ModBackgroundAgentContext {
  type: string;
  status: string;
  durationMs: number;
  agentId: string | null;
}

export interface ModUiCapabilities {
  panels: boolean;
}

export interface ModEventCapabilities {
  lifecycle: boolean;
  tools: boolean;
  turns: boolean;
  compact: boolean;
  llm: boolean;
}

export interface ModCapabilities {
  tools: boolean;
  commands: boolean;
  events: ModEventCapabilities;
  permissions: boolean;
  providers: boolean;
  ui: ModUiCapabilities;
}

export interface ModConversationForkOptions {
  hidden?: boolean;
}

export type ModConversationMessage = MessageCreate | ApprovalCreate;

export interface ModConversationSendMessageOptions {
  background?: boolean;
  overrideModel?: string;
  skipImageNormalization?: boolean;
  streamTokens?: boolean;
  workingDirectory?: string;
}

export interface ModConversationSendMessageRequestOptions {
  headers?: Record<string, string>;
  maxRetries?: number;
  signal?: AbortSignal;
}

export interface ModConversationHistoryOptions {
  /** Maximum number of recent messages to return. Defaults to 100. */
  limit?: number;
  /** Return chronological (asc, default) or newest-first (desc) messages. */
  order?: "asc" | "desc";
  /** Include error messages and error statuses. Defaults to true. */
  includeErrors?: boolean;
}

export interface ModUpdateLlmConfigOptions {
  /** Model handle, e.g. "anthropic/claude-opus-4-8". Omit to keep the current model. */
  model?: string;
  /** Reasoning effort tier. Omit to leave reasoning settings untouched. */
  reasoningEffort?: ModelReasoningEffort;
  /** Context window limit. Omit to leave the current limit untouched. */
  contextWindow?: number;
  /**
   * Whether the change applies to this conversation only (default) or to the
   * agent's default config. Conversation scope avoids mutating the agent default.
   */
  scope?: "conversation" | "agent";
}

export interface ModConversationHandle {
  id: string | null;
  fork: (
    options?: ModConversationForkOptions,
  ) => Promise<ModConversationHandle>;
  getHistory: (options?: ModConversationHistoryOptions) => Promise<Message[]>;
  sendMessageStream: (
    messages: ModConversationMessage[],
    options?: ModConversationSendMessageOptions,
    requestOptions?: ModConversationSendMessageRequestOptions,
  ) => Promise<AsyncIterable<LettaStreamingResponse>>;
  /**
   * Update the model, reasoning effort, and/or context window for this
   * conversation (or the agent default with scope: "agent"). Only the fields you
   * pass change; others are preserved. Works for local and constellation agents.
   */
  updateLlmConfig: (options: ModUpdateLlmConfigOptions) => Promise<void>;
}

export type ModSourceScope =
  | "legacy_global"
  | "global"
  | "project"
  | "bundled"
  | "agent";

export interface ModOwner {
  id: string;
  path: string;
  scope: ModSourceScope;
  generation: number;
}

export type ModEventName =
  | "conversation_open"
  | "conversation_close"
  | "tool_start"
  | "tool_end"
  | "turn_start"
  | "turn_end"
  | "compact_start"
  | "compact_end"
  | "llm_start"
  | "llm_end";

export type ModConversationOpenReason =
  | "startup"
  | "new"
  | "resume"
  | "fork"
  | "reload";

export type ModConversationCloseReason =
  | "quit"
  | "new"
  | "resume"
  | "fork"
  | "reload";

export interface ModConversationOpenEvent {
  agentId: string | null;
  agentName: string | null;
  conversationId: string | null;
  previousConversationId?: string | null;
  reason: ModConversationOpenReason;
}

export interface ModConversationCloseEvent {
  agentId: string | null;
  conversationId: string | null;
  durationMs: number | null;
  messageCount: number | null;
  reason: ModConversationCloseReason;
  toolCallCount: number | null;
}

export interface ModTurnStartEvent {
  agentId: string | null;
  conversationId: string | null;
  input: Array<MessageCreate | ApprovalCreate>;
}

export interface ModTurnStartCancelResult {
  reason: string;
}

export interface ModTurnStartResult {
  input?: Array<MessageCreate | ApprovalCreate>;
  cancel?: ModTurnStartCancelResult;
}

export interface ModToolStartEvent {
  agentId: string | null;
  conversationId: string | null;
  toolCallId: string | null;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ModToolStartResult {
  args?: Record<string, unknown>;
  result?: { status: "success" | "error"; output: string };
}

export interface ModToolEndEvent {
  agentId: string | null;
  conversationId: string | null;
  toolCallId: string | null;
  toolName: string;
  args: Record<string, unknown>;
  status: "success" | "error";
  output: string;
}

export interface ModToolEndResult {
  result?: { status: "success" | "error"; output: string };
}

export interface ModTurnEndEvent {
  agentId: string | null;
  conversationId: string | null;
  stopReason: string;
  assistantMessage?: string;
}

export interface ModTurnEndResult {
  continue?: string;
}

export type ModCompactTrigger =
  | "manual"
  | "context_window_overflow"
  | "context_window_limit";

export interface ModCompactStartEvent {
  agentId: string | null;
  conversationId: string | null;
  trigger: ModCompactTrigger;
}

export interface ModCompactEndEvent {
  agentId: string | null;
  conversationId: string | null;
  trigger: ModCompactTrigger;
  messagesBefore: number;
  messagesAfter: number;
  contextTokensBefore: number;
  contextTokensAfter: number;
}

export interface ModLlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModLlmEndError {
  message: string;
  detail: string;
  errorType: "llm_error" | "local_backend_error";
  retryable: boolean;
}

export interface ModLlmStartEvent {
  agentId: string | null;
  conversationId: string | null;
  model: string;
  messageCount: number;
  contextWindow: number;
}

export interface ModLlmEndEvent {
  agentId: string | null;
  conversationId: string | null;
  model: string;
  stopReason: string;
  usage: ModLlmUsage | null;
  durationMs: number;
  error?: ModLlmEndError;
}

export interface ModEventMap {
  conversation_open: ModConversationOpenEvent;
  conversation_close: ModConversationCloseEvent;
  tool_start: ModToolStartEvent;
  tool_end: ModToolEndEvent;
  turn_start: ModTurnStartEvent;
  turn_end: ModTurnEndEvent;
  compact_start: ModCompactStartEvent;
  compact_end: ModCompactEndEvent;
  llm_start: ModLlmStartEvent;
  llm_end: ModLlmEndEvent;
}

export interface ModEventResultMap {
  conversation_open: undefined;
  conversation_close: undefined;
  tool_start: ModToolStartResult | undefined;
  tool_end: ModToolEndResult | undefined;
  turn_start: ModTurnStartResult | undefined;
  turn_end: ModTurnEndResult | undefined;
  compact_start: undefined;
  compact_end: undefined;
  llm_start: undefined;
  llm_end: undefined;
}

export interface ModInvocationContext extends ModContext {}

export interface ModEventContext extends ModInvocationContext {
  conversation: ModConversationHandle;
  signal: AbortSignal;
}

export type ModEventHandler<TName extends ModEventName = ModEventName> = (
  event: ModEventMap[TName],
  context: ModEventContext,
) => ModEventResultMap[TName] | Promise<ModEventResultMap[TName]>;

export interface ModEventRegistration<
  TName extends ModEventName = ModEventName,
> {
  handler: ModEventHandler<TName>;
  name: TName;
  owner: ModOwner;
}

export interface ModEventEmissionResult<
  TName extends ModEventName = ModEventName,
> {
  diagnostics: ModDiagnostic[];
  handlerCount: number;
  name: TName;
  results: Array<NonNullable<ModEventResultMap[TName]>>;
}

export type ModCapabilityKind =
  | "api"
  | "command"
  | "event"
  | "permission"
  | "provider"
  | "tool"
  | "panel"
  | "status"
  | "statusline";

export interface ModCapabilityRecord<T> {
  id: string;
  kind: ModCapabilityKind;
  owner: ModOwner;
  value: T;
  createdAt: number;
}

export type ModDiagnosticPhase =
  | "transpile"
  | "import"
  | "activate"
  | "legacy_extension"
  | "package_manifest"
  | "command_override"
  | "command.run"
  | "deprecated_api"
  | "dispose"
  | "event"
  | "permission.check"
  | "permission.isEnabled"
  | "report"
  | "stale_handle"
  | "status.evaluate"
  | "statusline.render"
  | "tool.isEnabled"
  | "tool.run";

export type ModDiagnosticSeverity = "error" | "warning";

export interface ModDiagnosticReportOptions {
  message: string;
  severity?: ModDiagnosticSeverity;
}

export interface ModDiagnostic {
  capability?: {
    id: string;
    kind: ModCapabilityKind;
  };
  error: Error;
  owner: ModOwner;
  phase: ModDiagnosticPhase;
  severity?: ModDiagnosticSeverity;
  timestamp: number;
}

export interface ModContext {
  app: {
    version: string;
  };
  workspace: ModWorkspaceContext;
  cwd: string;
  sessionId: string | null;
  conversationSummary: string | null;
  lastRunId: string | null;
  agent: ModAgentContext;
  model: ModModelContext;
  toolset: string | null;
  systemPromptId: string | null;
  permissionMode: string | null;
  networkPhase: "upload" | "download" | "error" | null;
  terminalWidth: number | null;
  contextWindow: ModContextWindowContext;
  cost: ModCostContext;
  reflection: ModReflectionContext;
  memfs: ModMemfsContext;
  backgroundAgents: ModBackgroundAgentContext[];
  subagents: SubagentLifecycleContext;
}

export interface ModCommandContext extends ModInvocationContext {
  rawInput: string;
  command: string;
  args: string;
  argv: string[];
  conversation: ModConversationHandle & { id: string };
}

export type ModCommandResult =
  | { type: "prompt"; content: string; systemReminder?: boolean }
  | { type: "output"; output: string; success?: boolean }
  | { type: "handled" };

/** Live mod context (`cwd`, workspace, agent, model, cost, etc.) plus panel helpers. */
export interface ModPanelRenderContext extends ModContext {
  /** Visible width available to the panel, in columns. */
  width: number;
  /** Lay out a left and right segment across `width` (ANSI-aware). */
  row: (left: string, right: string, width: number) => string;
  /** Spread parts evenly across `width` (ANSI-aware). */
  columns: (parts: string[], width: number) => string;
  /** Build a terminal hyperlink string. */
  link: (label: string, url: string) => string;
  /** Chalk instance for coloring panel output. */
  chalk: ChalkInstance;
}

export type ModPanelRender = (ctx: ModPanelRenderContext) => string | string[];

/**
 * Panels are placed by a signed `order` around the input:
 * `> 1` renders above the input (highest at the top), `1` replaces the default
 * product-status row, `0` is the primary line just below the input (overrides
 * the built-in agent · model line), and `< 0` stacks below the primary line.
 * A panel whose render is empty is hidden.
 */
export interface ModPanelOptions {
  id: string;
  render: ModPanelRender;
  order?: number;
}

export interface ModPanel {
  render: ModPanelRender;
  id: string;
  owner?: ModOwner;
  order: number;
  path: string;
  updatedAt: number;
}

export interface ModPanelHandle {
  close: () => void;
  update: (options?: { order?: number }) => void;
}

export interface ModCommandRegistration {
  id: string;
  description: string;
  args?: string;
  order?: number;
  override?: boolean;
  runWhenBusy?: boolean;
  showInTranscript?: boolean;
  run: (
    context: ModCommandContext,
  ) => ModCommandResult | Promise<ModCommandResult>;
}

export interface ModCommand {
  id: string;
  description: string;
  args?: string;
  owner?: ModOwner;
  order: number;
  path: string;
  runWhenBusy: boolean;
  showInTranscript: boolean;
  run: ModCommandRegistration["run"];
  recordDiagnostic?: (
    diagnostic: Pick<
      ModDiagnostic,
      "capability" | "error" | "phase" | "severity"
    >,
  ) => void;
}

export interface ModToolContentText {
  type: "text";
  text: string;
}

export interface ModToolContentImage {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export type ModToolContent = ModToolContentText | ModToolContentImage;

export type ModToolRunResult =
  | string
  | ModToolContent[]
  | {
      content?: string | ModToolContent[];
      output?: string;
      stdout?: string[];
      stderr?: string[];
      status?: "success" | "error";
      isError?: boolean;
      success?: boolean;
    };

export type ModSecretResolver = (
  name: string,
  options?: { envFallback?: boolean },
) => Promise<string | null>;

export interface ModToolRunContext extends ModInvocationContext {
  args: Record<string, unknown>;
  toolCallId: string | null;
  signal: AbortSignal;
  secret: ModSecretResolver;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  conversation: ModConversationHandle;
}

export type ToolApprovalPolicy = "auto" | "ask" | "alwaysAsk";

export interface ModToolRegistration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  override?: boolean;
  requiresApproval?: boolean;
  approvalPolicy?: ToolApprovalPolicy;
  parallelSafe?: boolean;
  isEnabled?: (context: ModInvocationContext) => boolean;
  run: (
    context: ModToolRunContext,
  ) => ModToolRunResult | Promise<ModToolRunResult>;
}

export interface ModTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  owner?: ModOwner;
  path: string;
  requiresApproval: boolean;
  approvalPolicy: ToolApprovalPolicy;
  parallelSafe: boolean;
  isEnabled?: ModToolRegistration["isEnabled"];
  run: ModToolRegistration["run"];
}

export type ModPermissionDecision = "allow" | "ask" | "alwaysAsk" | "deny";

export type ModPermissionCheckPhase = "approval" | "execution";

export interface ModPermissionCheckEvent {
  agentId: string | null;
  conversationId: string | null;
  toolCallId: string | null;
  toolName: string;
  args: Record<string, unknown>;
  cwd: string;
  workingDirectory: string;
  permissionMode: string | null;
  phase: ModPermissionCheckPhase;
}

export type ModPermissionCheckResult =
  | {
      decision: ModPermissionDecision;
      reason?: string;
    }
  | undefined;

export interface ModPermissionCheckContext extends ModInvocationContext {
  signal: AbortSignal;
}

export interface ModPermissionRegistration {
  id: string;
  description?: string;
  isEnabled?: (context: ModInvocationContext) => boolean;
  check: (
    event: ModPermissionCheckEvent,
    context: ModPermissionCheckContext,
  ) => ModPermissionCheckResult | Promise<ModPermissionCheckResult>;
}

export interface ModPermission {
  id: string;
  description?: string;
  owner?: ModOwner;
  path: string;
  isEnabled?: ModPermissionRegistration["isEnabled"];
  check: ModPermissionRegistration["check"];
}
