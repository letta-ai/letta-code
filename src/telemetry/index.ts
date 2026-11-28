import { randomUUID } from "node:crypto";
import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import { getServerHealth } from "@/backend/api/health";
import { submitTelemetryMetadata } from "@/backend/api/metadata";
import { getServerUrl } from "@/backend/api/server-url";
import { isLocalBackendEnvEnabled } from "@/backend/local/paths";
import { getRuntimeActingUserId } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import { debugLogFile, isDebugEnabled } from "@/utils/debug";
import { isLoopbackHostname, parseUrl } from "@/utils/url";
import { getVersion } from "@/version";
import {
  resolveTelemetryAgentOrigin,
  type TelemetryAgentOrigin,
} from "./agent-origin";
import { extractInputChannel } from "./channel";
import { isPermanentRejection, TelemetryEventQueueCap } from "./event-queue";
import { installFatalErrorHandlers } from "./fatal-error-handler";
import type { PermissionModeChangedData } from "./permission-mode";

export type TelemetrySurface =
  | "letta_code_tui"
  | "letta_code_headless"
  | "letta_code_cli_server"
  | "letta_code_desktop";

export type TelemetryBackend =
  | "cloud"
  | "local"
  | "docker_deprecated"
  | "self_hosted_api"
  | "unknown";

export interface TelemetryInitOptions {
  handleSigint?: boolean;
}
export interface TelemetryEvent {
  type:
    | "session_start"
    | "session_end"
    | "tool_usage"
    | "error"
    | "user_input"
    | "channel_gateway_lifecycle"
    | "reflection_start"
    | "reflection_end"
    | "reflection_worktree_cleanup"
    | "permission_mode_changed";
  timestamp: string;
  data: Record<string, unknown>;
}
export interface SessionStartData {
  startup_command: string;
  version: string;
  platform: string;
  node_version: string;
}
export interface SessionEndData {
  duration: number;
  message_count: number;
  tool_call_count: number;
  exit_reason?: string;
  total_api_ms?: number;
  total_wall_ms?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_input_tokens?: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  context_tokens?: number;
  step_count?: number;
}
export interface ToolUsageData {
  tool_name: string;
  channel?: string;
  channel_action?: string;
  success: boolean;
  duration: number;
  response_length?: number;
  error_type?: string;
  stderr?: string;
}
export interface ErrorData {
  error_type: string;
  error_message: string;
  context?: string;
  http_status?: number;
  model_id?: string;
  run_id?: string;
  recent_chunks?: Record<string, unknown>[];
  debug_log_tail?: string;
  is_subagent?: boolean;
  subagent_type?: string;
  model_handle?: string;
  fallback_kind?: string;
  platform?: string;
  version?: string;
}

export interface UserInputData {
  input_length: number;
  channel?: string;
  is_command: boolean;
  command_name?: string;
  message_type: string;
  model_id: string;
}

export interface ChannelGatewayLifecycleData {
  lifecycle_event:
    | "exit"
    | "process_error"
    | "restart_scheduled"
    | "restart_ready"
    | "restart_exhausted";
  restart_attempt: number;
  max_restart_attempts: number;
  restore_mode: "explicit_channels" | "enabled_accounts";
  channel_types: string[];
  duration_ms?: number;
  delay_ms?: number;
  exit_code?: number | null;
  signal?: string | null;
  reached_ready?: boolean;
  version?: string;
  platform?: string;
}

export type ReflectionTriggerSource =
  | "manual"
  | "step-count"
  | "compaction-event";

export interface ReflectionStartData {
  trigger_source: ReflectionTriggerSource;
  subagent_id?: string;
  conversation_id?: string;
  start_message_id?: string;
  end_message_id?: string;
  model?: string;
  version?: string;
  platform?: string;
}

export interface ReflectionEndData {
  trigger_source: ReflectionTriggerSource;
  success: boolean;
  subagent_id?: string;
  conversation_id?: string;
  error?: string;
  step_count?: number;
  duration_ms?: number;
  model?: string;
  version?: string;
  platform?: string;
}

export type ReflectionWorktreeCleanupOutcome =
  | "parent_dirty"
  | "merge_conflict"
  | "reflection_worktree_dirty"
  | "subagent_failed";

export interface ReflectionWorktreeCleanupData {
  outcome: ReflectionWorktreeCleanupOutcome;
  integration_status:
    | "parent_dirty"
    | "merge_conflict"
    | "dirty_uncommitted"
    | "failed";
  trigger_source?: ReflectionTriggerSource;
  subagent_id?: string;
  conversation_id?: string;
  reflection_worktree_id?: string;
  commit_count?: number;
  model?: string;
  version?: string;
  platform?: string;
}

export function isLettaCodeDesktopRuntime(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.LETTA_DESKTOP_MODE === "1";
}

export function getTerminalTelemetrySurface(
  isHeadless: boolean,
): TelemetrySurface {
  return isHeadless ? "letta_code_headless" : "letta_code_tui";
}

export function getListenerTelemetrySurface(
  env: NodeJS.ProcessEnv = process.env,
): TelemetrySurface {
  return isLettaCodeDesktopRuntime(env)
    ? "letta_code_desktop"
    : "letta_code_cli_server";
}

function isTelemetryCloudServerUrl(serverUrl: string): boolean {
  const parsed = parseUrl(serverUrl, { allowMissingProtocol: true });
  const cloud = parseUrl(LETTA_CLOUD_API_URL, { allowMissingProtocol: true });
  return Boolean(parsed && cloud && parsed.hostname === cloud.hostname);
}

function isLikelyDeprecatedDockerBackendUrl(serverUrl: string): boolean {
  const parsed = parseUrl(serverUrl, { allowMissingProtocol: true });
  return Boolean(
    parsed && isLoopbackHostname(parsed.hostname) && parsed.port === "8283",
  );
}

function getServerUrlForTelemetry(): string | null {
  try {
    return getServerUrl();
  } catch {
    return process.env.LETTA_BASE_URL || LETTA_CLOUD_API_URL;
  }
}

export function resolveTelemetryBackend(options?: {
  env?: NodeJS.ProcessEnv;
  serverUrl?: string | null;
}): TelemetryBackend {
  const env = options?.env ?? process.env;
  if (isLocalBackendEnvEnabled(env)) {
    return "local";
  }

  const serverUrl = Object.hasOwn(options ?? {}, "serverUrl")
    ? options?.serverUrl
    : getServerUrlForTelemetry();
  if (!serverUrl) {
    return "unknown";
  }

  if (isTelemetryCloudServerUrl(serverUrl)) {
    return "cloud";
  }

  if (isLettaCodeDesktopRuntime(env)) {
    return "cloud";
  }

  if (isLikelyDeprecatedDockerBackendUrl(serverUrl)) {
    return "docker_deprecated";
  }

  return "self_hosted_api";
}

function isNonActionableError(message: string): boolean {
  return (
    /premium-unavailable|not-enough-credits|usage-exceeded/i.test(message) ||
    /Cancelled by user|SIGTSTP/i.test(message) ||
    /ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up|EPROTO/i.test(message) ||
    /Connection error\./i.test(message) ||
    /\{"isTrusted":\s*true\}/.test(message) ||
    /spawn (git|npm) ENOENT/.test(message) ||
    /\bCONFLICT\b/.test(message) ||
    /@author\/agent not found/.test(message)
  );
}

class TelemetryManager {
  private events: TelemetryEvent[] = [];
  private eventActingUsers = new WeakMap<TelemetryEvent, string | undefined>();
  private sessionId: string;
  private deviceId: string | null = null;
  private currentAgentId: string | null = null;
  private currentAgentOrigin: TelemetryAgentOrigin | null = null;
  private surface: TelemetrySurface = "letta_code_tui";
  private sessionStartTime: number;
  private messageCount = 0;
  private toolCallCount = 0;
  private sessionEndTracked = false;
  private initialized = false;
  private flushInterval: NodeJS.Timeout | null = null;
  private removeSigintHandler: (() => void) | null = null;
  private removeFatalErrorHandlers: (() => void) | null = null;
  private serverVersion: string | null = null;
  private inflightFlush: Promise<void> | null = null;
  private eventQueueCap = new TelemetryEventQueueCap();

  private async resolveTelemetryApiKey(): Promise<string | undefined> {
    if (process.env.LETTA_API_KEY) {
      return process.env.LETTA_API_KEY;
    }

    try {
      const settings = await settingsManager.getSettingsWithSecureTokens();
      return settings.env?.LETTA_API_KEY || undefined;
    } catch {
      return undefined;
    }
  }

  private getTelemetryDeviceId(): string {
    const existing = this.deviceId?.trim();
    if (existing) {
      return existing;
    }

    try {
      const generated = settingsManager.getOrCreateDeviceId().trim();
      if (generated) {
        this.deviceId = generated;
        return generated;
      }
    } catch {}

    const fallback = randomUUID();
    this.deviceId = fallback;
    return fallback;
  }

  private readonly FLUSH_INTERVAL_MS = 2 * 60 * 1000;
  private readonly MAX_BATCH_SIZE = 50;
  private readonly DRAIN_TIMEOUT_MS = 3_000;
  private sessionStatsGetter?: () => {
    totalWallMs: number;
    totalApiMs: number;
    usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      cachedInputTokens: number;
      cacheWriteTokens: number;
      reasoningTokens: number;
      contextTokens?: number;
      stepCount: number;
    };
  };

  constructor() {
    this.sessionId = this.generateSessionId();
    this.sessionStartTime = Date.now();
  }

  private generateSessionId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  }

  private isTelemetryEnabled(): boolean {
    const envValue = process.env.LETTA_CODE_TELEM;
    if (envValue === "0" || envValue === "false") {
      return false;
    }

    if (process.env.DO_NOT_TRACK === "1") {
      return false;
    }

    return true;
  }

  private isCloudUser(): boolean {
    try {
      return getServerUrl().includes("api.letta.com");
    } catch {
      return (
        !process.env.LETTA_BASE_URL ||
        process.env.LETTA_BASE_URL.includes("api.letta.com")
      );
    }
  }

  init(options: TelemetryInitOptions = {}) {
    if (!this.isTelemetryEnabled() || this.initialized) {
      return;
    }
    this.initialized = true;

    this.deviceId = settingsManager.getOrCreateDeviceId();

    this.trackSessionStart();

    this.fetchServerVersion().catch(() => {});

    this.flushInterval = setInterval(() => {
      this.flush().catch((err) => {
        if (isDebugEnabled()) {
          console.error("Telemetry flush error:", err);
        }
      });
    }, this.FLUSH_INTERVAL_MS);

    this.flushInterval.unref();

    if (options.handleSigint !== false) {
      const sigintHandler = () => {
        void (async () => {
          try {
            this.trackSessionEnd(undefined, "sigint");
            await this.drain();
          } catch {}
          process.exit(0);
        })();
      };
      process.on("SIGINT", sigintHandler);
      this.removeSigintHandler = () => {
        process.off("SIGINT", sigintHandler);
      };
    }

    this.removeFatalErrorHandlers = installFatalErrorHandlers({
      drain: () => this.drain(),
      trackError: (errorType, message, context) => {
        this.trackError(errorType, message, context);
      },
    });
  }

  private track(
    type: TelemetryEvent["type"],
    data:
      | Record<string, unknown>
      | SessionStartData
      | SessionEndData
      | ToolUsageData
      | ErrorData
      | UserInputData
      | ChannelGatewayLifecycleData
      | PermissionModeChangedData
      | ReflectionStartData
      | ReflectionEndData
      | ReflectionWorktreeCleanupData,
  ) {
    if (!this.isTelemetryEnabled()) {
      return;
    }

    const event: TelemetryEvent = {
      type,
      timestamp: new Date().toISOString(),
      data: {
        ...data,
        session_id: this.sessionId,
        agent_id:
          type === "permission_mode_changed"
            ? (data as PermissionModeChangedData).agent_id
            : this.currentAgentId || undefined,
        agent_origin: this.currentAgentOrigin || undefined,
        surface: this.surface,
        backend: resolveTelemetryBackend(),
      },
    };

    this.eventActingUsers.set(event, getRuntimeActingUserId());
    this.events.push(event);
    this.eventQueueCap.enforce(this.events);

    if (this.events.length >= this.MAX_BATCH_SIZE) {
      this.flush().catch((err) => {
        if (isDebugEnabled()) {
          console.error("Telemetry flush error:", err);
        }
      });
    }
  }

  setCurrentAgentId(agentId: string | null) {
    this.currentAgentId = agentId;
    this.currentAgentOrigin = null;
  }

  setCurrentAgent(
    agentId: string | null,
    tags: readonly string[] | null | undefined,
  ) {
    this.currentAgentId = agentId;
    this.currentAgentOrigin = agentId
      ? (resolveTelemetryAgentOrigin(tags) ?? null)
      : null;

    if (!agentId) {
      return;
    }

    for (const event of this.events) {
      if (event.data.agent_id && event.data.agent_id !== agentId) {
        continue;
      }
      event.data.agent_id = agentId;
      if (this.currentAgentOrigin) {
        event.data.agent_origin = this.currentAgentOrigin;
      }
    }
  }

  setSurface(surface: TelemetrySurface) {
    this.surface = surface;
  }

  async fetchServerVersion(): Promise<void> {
    try {
      const data = await getServerHealth({
        baseUrl: getServerUrl(),
        signal: AbortSignal.timeout(3000),
      });
      if (data.version) {
        this.serverVersion = data.version;
      }
    } catch {}
  }

  getServerVersion(): string | null {
    return this.serverVersion;
  }

  setSessionStatsGetter(
    getter?: () => {
      totalWallMs: number;
      totalApiMs: number;
      usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        cachedInputTokens: number;
        cacheWriteTokens: number;
        reasoningTokens: number;
        contextTokens?: number;
        stepCount: number;
      };
    },
  ) {
    this.sessionStatsGetter = getter;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getMessageCount(): number {
    return this.messageCount;
  }

  getToolCallCount(): number {
    return this.toolCallCount;
  }

  trackSessionStart() {
    const args = process.argv.slice(2);
    const agentFlagIndex = args.findIndex(
      (arg) => arg === "--agent" || arg === "-a",
    );
    if (agentFlagIndex !== -1 && agentFlagIndex + 1 < args.length) {
      const agentId = args[agentFlagIndex + 1];
      if (agentId) {
        this.currentAgentId = agentId;
      }
    }

    const data: SessionStartData = {
      startup_command: args.join(" "),
      version: getVersion(),
      platform: process.platform,
      node_version: process.version,
    };
    this.track("session_start", data);
  }

  trackSessionEnd(
    stats?: {
      totalWallMs: number;
      totalApiMs: number;
      usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        cachedInputTokens: number;
        cacheWriteTokens: number;
        reasoningTokens: number;
        contextTokens?: number;
        stepCount: number;
      };
    },
    exitReason?: string,
  ) {
    if (this.sessionEndTracked) {
      return;
    }
    this.sessionEndTracked = true;

    let sessionStats = stats;
    if (!sessionStats && this.sessionStatsGetter) {
      try {
        sessionStats = this.sessionStatsGetter();
      } catch {}
    }

    const duration = Math.floor((Date.now() - this.sessionStartTime) / 1000);
    const data: SessionEndData = {
      duration,
      message_count: this.messageCount,
      tool_call_count: this.toolCallCount,
      exit_reason: exitReason,
      total_api_ms: sessionStats?.totalApiMs,
      total_wall_ms: sessionStats?.totalWallMs,
      prompt_tokens: sessionStats?.usage.promptTokens,
      completion_tokens: sessionStats?.usage.completionTokens,
      total_tokens: sessionStats?.usage.totalTokens,
      cached_input_tokens: sessionStats?.usage.cachedInputTokens,
      cached_tokens: sessionStats?.usage.cachedInputTokens,
      cache_write_tokens: sessionStats?.usage.cacheWriteTokens,
      reasoning_tokens: sessionStats?.usage.reasoningTokens,
      context_tokens: sessionStats?.usage.contextTokens,
      step_count: sessionStats?.usage.stepCount,
    };
    this.track("session_end", data);
  }

  trackToolUsage(
    toolName: string,
    success: boolean,
    duration: number,
    responseLength?: number,
    errorType?: string,
    stderr?: string,
    channelMetadata?: Pick<ToolUsageData, "channel" | "channel_action">,
  ) {
    this.toolCallCount++;
    const data: ToolUsageData = {
      tool_name: toolName,
      success,
      duration,
      response_length: responseLength,
      error_type: errorType,
      stderr,
      ...channelMetadata,
    };
    this.track("tool_usage", data);
  }

  trackChannelGatewayLifecycle(
    data: Omit<ChannelGatewayLifecycleData, "version" | "platform">,
  ) {
    this.track("channel_gateway_lifecycle", {
      ...data,
      version: getVersion(),
      platform: process.platform,
    });
  }

  trackPermissionModeChanged(data: PermissionModeChangedData) {
    this.track("permission_mode_changed", data);
  }

  trackError(
    errorType: string,
    errorMessage: string,
    context?: string,
    options?: {
      httpStatus?: number;
      modelId?: string;
      runId?: string;
      recentChunks?: Record<string, unknown>[];
      isSubagent?: boolean;
      subagentType?: string;
      modelHandle?: string;
      fallbackKind?: string;
      omitDebugLogTail?: boolean;
    },
  ) {
    if (!this.isCloudUser()) {
      return;
    }

    if (isNonActionableError(errorMessage)) {
      return;
    }

    const data: ErrorData = {
      error_type: errorType,
      error_message: errorMessage,
      context,
      http_status: options?.httpStatus,
      model_id: options?.modelId,
      run_id: options?.runId,
      recent_chunks: options?.recentChunks,
      debug_log_tail: options?.omitDebugLogTail
        ? undefined
        : debugLogFile.getTail(),
      is_subagent: options?.isSubagent,
      subagent_type: options?.subagentType,
      model_handle: options?.modelHandle,
      fallback_kind: options?.fallbackKind,
      platform: process.platform,
      version: getVersion(),
    };
    this.track("error", data);
  }

  trackUserInput(input: string, messageType: string, modelId: string) {
    this.messageCount++;

    const isCommand = input.trim().startsWith("/");
    const commandName = isCommand ? input.trim().split(/\s+/)[0] : undefined;

    const data: UserInputData = {
      input_length: input.length,
      is_command: isCommand,
      command_name: commandName,
      message_type: messageType,
      model_id: modelId,
      channel: extractInputChannel(input),
    };
    this.track("user_input", data);
  }

  trackReflectionStart(
    triggerSource: ReflectionTriggerSource,
    options?: {
      subagentId?: string;
      conversationId?: string;
      startMessageId?: string;
      endMessageId?: string;
      model?: string | null;
    },
  ) {
    const data: ReflectionStartData = {
      trigger_source: triggerSource,
      subagent_id: options?.subagentId,
      conversation_id: options?.conversationId,
      start_message_id: options?.startMessageId,
      end_message_id: options?.endMessageId,
      model: options?.model ?? undefined,
      version: getVersion(),
      platform: process.platform,
    };
    this.track("reflection_start", data);
  }

  trackReflectionEnd(
    triggerSource: ReflectionTriggerSource,
    success: boolean,
    options?: {
      subagentId?: string;
      conversationId?: string;
      error?: string;
      stepCount?: number;
      durationMs?: number;
      model?: string | null;
    },
  ) {
    const data: ReflectionEndData = {
      trigger_source: triggerSource,
      success,
      subagent_id: options?.subagentId,
      conversation_id: options?.conversationId,
      error: options?.error,
      step_count: options?.stepCount,
      duration_ms: options?.durationMs,
      model: options?.model ?? undefined,
      version: getVersion(),
      platform: process.platform,
    };
    this.track("reflection_end", data);
  }

  trackReflectionWorktreeCleanup(
    options: Omit<ReflectionWorktreeCleanupData, "version" | "platform">,
  ) {
    const data: ReflectionWorktreeCleanupData = {
      ...options,
      version: getVersion(),
      platform: process.platform,
    };
    this.track("reflection_worktree_cleanup", data);
  }

  async flush(): Promise<void> {
    if (this.inflightFlush) {
      return this.inflightFlush;
    }
    if (this.events.length === 0 || !this.isTelemetryEnabled()) {
      return;
    }

    this.inflightFlush = this.performFlush().finally(() => {
      this.inflightFlush = null;
    });
    return this.inflightFlush;
  }

  private async performFlush(): Promise<void> {
    const eventsToSend = [...this.events];
    this.events = [];

    const apiKey = await this.resolveTelemetryApiKey();

    const deviceId = this.getTelemetryDeviceId();

    const groups = new Map<string | undefined, TelemetryEvent[]>();
    for (const event of eventsToSend) {
      const actingUserId = this.eventActingUsers.get(event);
      const group = groups.get(actingUserId) ?? [];
      group.push(event);
      groups.set(actingUserId, group);
    }

    const failed = new Set<TelemetryEvent>();
    await Promise.all(
      [...groups].map(async ([actingUserId, events]) => {
        try {
          await submitTelemetryMetadata(
            apiKey,
            deviceId,
            {
              service: "letta-code",
              server_version: this.serverVersion || undefined,
              events,
            },
            { signal: AbortSignal.timeout(5000), actingUserId },
          );
        } catch (error) {
          if (isPermanentRejection(error)) return;
          for (const event of events) failed.add(event);
        }
      }),
    );
    this.events.unshift(...eventsToSend.filter((event) => failed.has(event)));
    this.eventQueueCap.enforce(this.events);
  }

  async drain(): Promise<void> {
    if (!this.isTelemetryEnabled()) {
      return;
    }
    const deadline = Date.now() + this.DRAIN_TIMEOUT_MS;
    while (this.events.length > 0 || this.inflightFlush) {
      if (Date.now() >= deadline) {
        return;
      }
      try {
        await this.flush();
      } catch {
        return;
      }
    }
  }

  cleanup() {
    this.removeSigintHandler?.();
    this.removeSigintHandler = null;
    this.removeFatalErrorHandlers?.();
    this.removeFatalErrorHandlers = null;
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    this.initialized = false;
  }
}

export const telemetry = new TelemetryManager();
