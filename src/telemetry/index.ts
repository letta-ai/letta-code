import { randomUUID } from "node:crypto";
import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import { getServerUrl } from "@/backend/api/client";
import { getServerHealth } from "@/backend/api/health";
import { submitTelemetryMetadata } from "@/backend/api/metadata";
import { isLocalBackendEnvEnabled } from "@/backend/local/paths";
import { settingsManager } from "@/settings-manager";
import { debugLogFile } from "@/utils/debug";
import { isLoopbackHostname, parseUrl } from "@/utils/url";
import { getVersion } from "@/version";

export type TelemetrySurface =
  | "letta_code_tui"
  | "letta_code_headless"
  | "letta_code_cli_server"
  | "letta_code_desktop";

export type TelemetryBackend =
  | "constellation"
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
    | "reflection_start"
    | "reflection_end"
    | "reflection_arena_vote";
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
  duration: number; // in seconds
  message_count: number;
  tool_call_count: number;
  exit_reason?: string; // e.g., "exit_command", "logout", "sigint", "process_exit"
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
}

export interface UserInputData {
  input_length: number;
  is_command: boolean;
  command_name?: string;
  message_type: string;
  model_id: string;
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

export interface ReflectionArenaVoteData {
  run_id: string;
  choice: "win_loss" | "tie";
  winner: string | null;
  loser: string | null;
  winner_agent_id: string | null;
  loser_agent_id: string | null;
  parent_agent_id: string;
  parent_convo_id: string;
  timestamp: string;
  feedbackstr: string | null;
  lc_version: string;
  memory_base_commit: string | null;
  memory_candidate_commit: string | null;
  transcript_payload: string | null;
  transcript_payload_chars: number | null;
  transcript_payload_truncated: boolean;
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
    return "constellation";
  }

  if (isLettaCodeDesktopRuntime(env)) {
    return "constellation";
  }

  if (isLikelyDeprecatedDockerBackendUrl(serverUrl)) {
    return "docker_deprecated";
  }

  return "self_hosted_api";
}

/**
 * Returns true for error messages that are non-actionable noise:
 * - Billing/plan limit responses (premium-unavailable, usage-exceeded, not-enough-credits)
 * - User-initiated actions (cancelled, Ctrl+Z)
 * - Transient connection errors (DNS, SSL, socket hang up) — NOT Cloudflare 521/520 (filtered in PostHog)
 * - Environment issues (git/npm not installed)
 * - Expected concurrency (409 CONFLICT)
 * - Placeholder agent names (@author/agent)
 */
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
  private sessionId: string;
  private deviceId: string | null = null;
  private currentAgentId: string | null = null;
  private surface: TelemetrySurface = "letta_code_tui";
  private sessionStartTime: number;
  private messageCount = 0;
  private toolCallCount = 0;
  private sessionEndTracked = false;
  private initialized = false;
  private flushInterval: NodeJS.Timeout | null = null;
  private serverVersion: string | null = null;
  /** Deduplicates concurrent flushes (prevents the 429 double-flush race on shutdown). */
  private inflightFlush: Promise<void> | null = null;

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
    } catch {
      // Settings may not be initialized in some early/exit flush paths. Fall
      // back to a process-local UUID so cloud pass-through telemetry never
      // sends an empty organization/device id.
    }

    const fallback = randomUUID();
    this.deviceId = fallback;
    return fallback;
  }

  private readonly FLUSH_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
  private readonly MAX_BATCH_SIZE = 50;
  /** Max time to drain queued events on exit (bounded so we never hang the shell). */
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

  /**
   * Check if telemetry is enabled based on environment variables.
   * Enabled by default unless explicitly disabled.
   */
  private isTelemetryEnabled(): boolean {
    // LETTA_CODE_TELEM is Letta Code's specific opt-out. DO_NOT_TRACK is a
    // broader convention also honored by install-time analytics packages.
    const envValue = process.env.LETTA_CODE_TELEM;
    if (envValue === "0" || envValue === "false") {
      return false;
    }

    if (process.env.DO_NOT_TRACK === "1") {
      return false;
    }

    return true;
  }

  /**
   * Check if the user is connected to Letta Cloud (api.letta.com)
   */
  private isCloudUser(): boolean {
    try {
      return getServerUrl().includes("api.letta.com");
    } catch {
      // Settings not initialized yet — check env var directly
      return (
        !process.env.LETTA_BASE_URL ||
        process.env.LETTA_BASE_URL.includes("api.letta.com")
      );
    }
  }

  /**
   * Initialize telemetry and start periodic flushing
   */
  init(options: TelemetryInitOptions = {}) {
    if (!this.isTelemetryEnabled() || this.initialized) {
      return;
    }
    this.initialized = true;

    // Initialize device ID (persistent across sessions)
    this.deviceId = settingsManager.getOrCreateDeviceId();

    this.trackSessionStart();

    // Fetch server version for diagnostics (best-effort, non-blocking)
    this.fetchServerVersion().catch(() => {});

    // Set up periodic flushing
    this.flushInterval = setInterval(() => {
      this.flush().catch((err) => {
        // Silently fail - we don't want telemetry to interfere with user experience
        if (process.env.LETTA_DEBUG) {
          console.error("Telemetry flush error:", err);
        }
      });
    }, this.FLUSH_INTERVAL_MS);

    // Don't let the interval prevent process from exiting
    this.flushInterval.unref();

    if (options.handleSigint !== false) {
      // Await drain() (bounded by DRAIN_TIMEOUT_MS) so the final batch ships before exit.
      process.on("SIGINT", () => {
        void (async () => {
          try {
            this.trackSessionEnd(undefined, "sigint");
            await this.drain();
          } catch {
            // Silently ignore - don't prevent process from exiting
          }
          process.exit(0);
        })();
      });
    }

    process.on("uncaughtException", (error) => {
      void (async () => {
        try {
          const msg = error instanceof Error ? error.message : String(error);
          // Broken pipe/TTY — not actionable (e.g. terminal closed while writing)
          if (/\b(EPIPE|EIO|EBADF)\b/.test(msg)) return;
          this.trackError(
            "uncaught_exception",
            msg,
            "process_uncaught_exception",
          );
          await this.drain();
        } catch {
          // Silently ignore - don't prevent process from exiting
        }
      })();
    });

    process.on("unhandledRejection", (reason) => {
      void (async () => {
        try {
          const msg = reason instanceof Error ? reason.message : String(reason);
          // Broken pipe/TTY — not actionable
          if (/\b(EPIPE|EIO|EBADF)\b/.test(msg)) return;
          // Rate limits surfacing as unhandled rejections — expected under load
          if (/\b429\b/.test(msg) && /rate.?limit/i.test(msg)) return;
          this.trackError(
            "unhandled_rejection",
            msg,
            "process_unhandled_rejection",
          );
          await this.drain();
        } catch {
          // Silently ignore - don't prevent process from exiting
        }
      })();
    });

    // TODO: Add telemetry for crashes and abnormal exits
    // Current limitation: We can't reliably flush telemetry on process.on("exit")
    // because the event loop is shut down and async operations don't work.
    // Potential solution: Write unsent events to ~/.letta/telemetry-queue.json
    // and send them on next startup. This would capture crash telemetry without
    // risking hangs on exit.
  }

  /**
   * Track a telemetry event
   */
  private track(
    type: TelemetryEvent["type"],
    data:
      | Record<string, unknown>
      | SessionStartData
      | SessionEndData
      | ToolUsageData
      | ErrorData
      | UserInputData
      | ReflectionStartData
      | ReflectionEndData
      | ReflectionArenaVoteData,
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
        agent_id: this.currentAgentId || undefined,
        surface: this.surface,
        backend: resolveTelemetryBackend(),
      },
    };

    this.events.push(event);

    // Flush if batch size is reached
    if (this.events.length >= this.MAX_BATCH_SIZE) {
      this.flush().catch((err) => {
        if (process.env.LETTA_DEBUG) {
          console.error("Telemetry flush error:", err);
        }
      });
    }
  }

  /**
   * Set the current agent ID (called from App.tsx when agent changes)
   * This is automatically added to all telemetry events
   */
  setCurrentAgentId(agentId: string | null) {
    this.currentAgentId = agentId;
  }

  setSurface(surface: TelemetrySurface) {
    this.surface = surface;
  }

  /**
   * Fetch and cache server version from /v1/health (fire-and-forget, best-effort)
   */
  async fetchServerVersion(): Promise<void> {
    try {
      const data = await getServerHealth({
        baseUrl: getServerUrl(),
        signal: AbortSignal.timeout(3000),
      });
      if (data.version) {
        this.serverVersion = data.version;
      }
    } catch {
      // Best-effort — don't let this affect startup
    }
  }

  getServerVersion(): string | null {
    return this.serverVersion;
  }

  /**
   * Set a getter function for session stats (called from App.tsx)
   * This allows safety net handlers to access stats even if not explicitly passed
   * Pass undefined to clear the getter (for cleanup)
   */
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

  /**
   * Get the current session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Get the current message count
   */
  getMessageCount(): number {
    return this.messageCount;
  }

  /**
   * Get the current tool call count
   */
  getToolCallCount(): number {
    return this.toolCallCount;
  }

  /**
   * Track session start
   */
  trackSessionStart() {
    // Extract agent ID from startup args if --agent or -a is provided
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

  /**
   * Track session end
   * @param stats Optional session stats (from sessionStatsRef.current.getSnapshot() in App.tsx)
   * @param exitReason Optional reason for exit (e.g., "exit_command", "logout", "sigint", "process_exit")
   */
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
    // Prevent double-tracking (can be called from both handleExit and process.on("exit"))
    if (this.sessionEndTracked) {
      return;
    }
    this.sessionEndTracked = true;

    // Try to get stats from getter if not provided (for safety net handlers)
    let sessionStats = stats;
    if (!sessionStats && this.sessionStatsGetter) {
      try {
        sessionStats = this.sessionStatsGetter();
      } catch {
        // Ignore errors - stats will be undefined
      }
    }

    const duration = Math.floor((Date.now() - this.sessionStartTime) / 1000);
    const data: SessionEndData = {
      duration,
      message_count: this.messageCount,
      tool_call_count: this.toolCallCount,
      exit_reason: exitReason,
      // Include optional stats if available
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

  /**
   * Track tool usage
   */
  trackToolUsage(
    toolName: string,
    success: boolean,
    duration: number,
    responseLength?: number,
    errorType?: string,
    stderr?: string,
  ) {
    this.toolCallCount++;
    const data: ToolUsageData = {
      tool_name: toolName,
      success,
      duration,
      response_length: responseLength,
      error_type: errorType,
      stderr,
    };
    this.track("tool_usage", data);
  }

  /**
   * Track errors
   */
  trackError(
    errorType: string,
    errorMessage: string,
    context?: string,
    options?: {
      httpStatus?: number;
      modelId?: string;
      runId?: string;
      recentChunks?: Record<string, unknown>[];
    },
  ) {
    // Skip error telemetry for self-hosted users to avoid spamming cloud analytics
    if (!this.isCloudUser()) {
      return;
    }

    // Skip non-actionable errors that create noise
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
      debug_log_tail: debugLogFile.getTail(),
    };
    this.track("error", data);
  }

  /**
   * Track user input
   * Note: agent_id is automatically added from currentAgentId
   */
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
    };
    this.track("user_input", data);
  }

  /**
   * Track reflection start events (manual and auto-triggered).
   */
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

  /**
   * Track reflection completion events.
   */
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

  trackReflectionArenaVote(
    vote: Omit<ReflectionArenaVoteData, "version" | "platform">,
  ) {
    this.track("reflection_arena_vote", {
      ...vote,
      version: getVersion(),
      platform: process.platform,
    });
  }

  /** Concurrent callers share one in-flight POST (prevents 429 double-flush race on shutdown). */
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

    try {
      await submitTelemetryMetadata(
        apiKey,
        deviceId,
        {
          service: "letta-code",
          server_version: this.serverVersion || undefined,
          events: eventsToSend,
        },
        { signal: AbortSignal.timeout(5000) },
      );
    } catch (_error) {
      // If flush fails, put events back in queue, but don't throw error
      this.events.unshift(...eventsToSend);
    }
  }

  /** Await in-flight flush and drain remaining queue (bounded by DRAIN_TIMEOUT_MS). Replaces fire-and-forget flush on exit. */
  async drain(): Promise<void> {
    if (!this.isTelemetryEnabled()) {
      return;
    }
    const deadline = Date.now() + this.DRAIN_TIMEOUT_MS;
    // Loop in case new events arrive mid-drain (e.g. trackError from uncaughtException).
    while (this.events.length > 0 || this.inflightFlush) {
      if (Date.now() >= deadline) {
        return;
      }
      try {
        await this.flush();
      } catch {
        // Swallow — already logged inside performFlush; don't block exit.
        return;
      }
    }
  }

  /**
   * Clean up resources
   */
  cleanup() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    this.initialized = false;
  }
}

// Export singleton instance
export const telemetry = new TelemetryManager();
