import { mkdirSync } from "node:fs";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getServerUrl } from "@/backend/api/client";
import { getServerHealth } from "@/backend/api/health";
import { submitTelemetryMetadata } from "@/backend/api/metadata";
import { settingsManager } from "@/settings-manager";
import { debugLogFile } from "@/utils/debug";
import { getVersion } from "@/version";

export type TelemetrySurface = "tui" | "headless" | "websocket";

export interface TelemetryEvent {
  type:
    | "session_start"
    | "session_end"
    | "tool_usage"
    | "error"
    | "user_input"
    | "reflection_start"
    | "reflection_end";
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

export interface ReflectionStartData {
  trigger_source: "manual" | "step-count" | "compaction-event";
  /**
   * Letta `agent-...` ID of the spawned reflection subagent. This is the
   * canonical join key for downstream pipelines (Postgres, ClickHouse,
   * letta-train). Should always be populated — call sites wait for the
   * subagent's init event before emitting `reflection_start`.
   */
  reflection_agent_id?: string;
  /**
   * Back-compat alias for `reflection_agent_id`. Older PostHog dashboards
   * and queries key off this field. New consumers should use
   * `reflection_agent_id`.
   */
  subagent_id?: string;
  conversation_id?: string;
  start_message_id?: string;
  end_message_id?: string;
}

export interface ReflectionEndData {
  trigger_source: "manual" | "step-count" | "compaction-event";
  success: boolean;
  /**
   * Letta `agent-...` ID of the spawned reflection subagent. Should match
   * the `reflection_agent_id` of the corresponding `reflection_start`
   * event, enabling exact start↔end joins in PostHog.
   */
  reflection_agent_id?: string;
  /**
   * Back-compat alias for `reflection_agent_id`. See `ReflectionStartData`.
   */
  subagent_id?: string;
  conversation_id?: string;
  error?: string;
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

/**
 * Resolve the path to the on-disk telemetry queue file. Returns `null` if
 * the queue is disabled (e.g. tests set `LETTA_CODE_TELEM_QUEUE=0`).
 *
 * The queue is a JSONL file storing events that have been emitted but not
 * yet confirmed flushed to the backend. It exists so that reflection
 * telemetry (and other events) survive process crashes / abnormal exits,
 * which is the dominant cause of `letta_code:reflection_start` events
 * being missing from PostHog in production.
 */
function resolveTelemetryQueuePath(): string | null {
  const override = process.env.LETTA_CODE_TELEM_QUEUE;
  if (override === "0" || override === "false") {
    return null;
  }
  if (override && override.length > 0) {
    return override;
  }
  try {
    const home = process.env.HOME || homedir();
    return join(home, ".letta", "telemetry-queue.jsonl");
  } catch {
    return null;
  }
}

class TelemetryManager {
  private events: TelemetryEvent[] = [];
  private sessionId: string;
  private deviceId: string | null = null;
  private currentAgentId: string | null = null;
  private surface: TelemetrySurface = "tui";
  private sessionStartTime: number;
  private messageCount = 0;
  private toolCallCount = 0;
  private sessionEndTracked = false;
  private initialized = false;
  private flushInterval: NodeJS.Timeout | null = null;
  private serverVersion: string | null = null;
  /**
   * Path to the disk-backed queue, resolved lazily. `null` means the queue
   * is disabled (env override) or its directory could not be resolved.
   */
  private queuePath: string | null | undefined = undefined;
  /**
   * Serialize queue writes so concurrent appends/rewrites don't interleave.
   * Best-effort: all queue operations swallow errors so telemetry never
   * affects user-facing behavior.
   */
  private queueWriteChain: Promise<void> = Promise.resolve();

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
  private readonly FLUSH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_BATCH_SIZE = 100;
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
   * Check if telemetry is enabled based on LETTA_CODE_TELEM env var
   * Enabled by default unless explicitly disabled or using self-hosted server
   */
  private isTelemetryEnabled(): boolean {
    // Check environment variable - must be explicitly set to "0" or "false" to disable
    const envValue = process.env.LETTA_CODE_TELEM;
    if (envValue === "0" || envValue === "false") {
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
  init() {
    if (!this.isTelemetryEnabled() || this.initialized) {
      return;
    }
    this.initialized = true;

    // Initialize device ID (persistent across sessions)
    this.deviceId = settingsManager.getOrCreateDeviceId();

    // Drain any events left behind by a previous crashed/abnormal exit
    // before we start recording new ones. Best-effort, never throws —
    // replayed events get retried on the next flush.
    this.drainQueueFromDisk().catch(() => {});

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

    // Safety net: Handle Ctrl+C interruption
    // Note: Normal exits via handleExit flush explicitly
    process.on("SIGINT", () => {
      try {
        this.trackSessionEnd(undefined, "sigint");
        // Fire and forget - try to flush but don't wait (might not complete)
        this.flush().catch(() => {
          // Silently ignore
        });
      } catch {
        // Silently ignore - don't prevent process from exiting
      }
      // Exit immediately - don't wait for flush
      process.exit(0);
    });

    process.on("uncaughtException", (error) => {
      try {
        const msg = error instanceof Error ? error.message : String(error);
        // Broken pipe/TTY — not actionable (e.g. terminal closed while writing)
        if (/\b(EPIPE|EIO|EBADF)\b/.test(msg)) return;
        this.trackError(
          "uncaught_exception",
          msg,
          "process_uncaught_exception",
        );
        this.flush().catch(() => {
          // Silently ignore
        });
      } catch {
        // Silently ignore - don't prevent process from exiting
      }
    });

    process.on("unhandledRejection", (reason) => {
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
        this.flush().catch(() => {
          // Silently ignore
        });
      } catch {
        // Silently ignore - don't prevent process from exiting
      }
    });

    // Note: events are also persisted to ~/.letta/telemetry-queue.jsonl
    // on every `track()`. If the process exits abnormally before a
    // successful flush, those events are replayed on next startup via
    // `drainQueueFromDisk()` (called from `init`). This is the durability
    // backbone for reflection telemetry, which was previously lost on
    // ~60% of invocations because flushes are best-effort on SIGINT.
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
      | ReflectionEndData,
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
      },
    };

    this.events.push(event);
    // Persist to disk so the event survives process crashes / abnormal
    // exits before the next flush. Best-effort, async, never throws.
    this.enqueueOnDisk(event);

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
    triggerSource: "manual" | "step-count" | "compaction-event",
    options?: {
      /**
       * Letta `agent-...` ID of the spawned reflection subagent. Callers
       * should wait for the subagent's init event before invoking this
       * method so this field is reliably populated.
       */
      reflectionAgentId?: string;
      conversationId?: string;
      startMessageId?: string;
      endMessageId?: string;
    },
  ) {
    const data: ReflectionStartData = {
      trigger_source: triggerSource,
      reflection_agent_id: options?.reflectionAgentId,
      // Emit both names: `subagent_id` for back-compat with existing
      // PostHog dashboards, `reflection_agent_id` as the new canonical
      // field. New consumers should prefer `reflection_agent_id`.
      subagent_id: options?.reflectionAgentId,
      conversation_id: options?.conversationId,
      start_message_id: options?.startMessageId,
      end_message_id: options?.endMessageId,
    };
    this.track("reflection_start", data);
  }

  /**
   * Track reflection completion events.
   */
  trackReflectionEnd(
    triggerSource: "manual" | "step-count" | "compaction-event",
    success: boolean,
    options?: {
      /**
       * Letta `agent-...` ID of the spawned reflection subagent. Should
       * match the `reflection_agent_id` of the corresponding
       * `reflection_start` event.
       */
      reflectionAgentId?: string;
      conversationId?: string;
      error?: string;
    },
  ) {
    const data: ReflectionEndData = {
      trigger_source: triggerSource,
      success,
      reflection_agent_id: options?.reflectionAgentId,
      subagent_id: options?.reflectionAgentId,
      conversation_id: options?.conversationId,
      error: options?.error,
    };
    this.track("reflection_end", data);
  }

  /**
   * Flush events to the server
   */
  async flush(): Promise<void> {
    if (this.events.length === 0 || !this.isTelemetryEnabled()) {
      return;
    }

    const eventsToSend = [...this.events];
    this.events = [];

    const apiKey = await this.resolveTelemetryApiKey();

    try {
      await submitTelemetryMetadata(
        apiKey,
        this.deviceId || "",
        {
          service: "letta-code",
          server_version: this.serverVersion || undefined,
          events: eventsToSend,
        },
        { signal: AbortSignal.timeout(5000) },
      );
      // Successful flush — rewrite the disk queue to drop the events we
      // just confirmed delivered. Anything still in `this.events` (new
      // events recorded during the flush) is preserved.
      this.rewriteQueueOnDisk();
    } catch {
      // If flush fails, put events back in queue, but don't throw error.
      // We intentionally do NOT rewrite the disk queue here — the on-disk
      // copy is still our durable backup for these events.
      this.events.unshift(...eventsToSend);
    }
  }

  /**
   * Resolve and cache the disk queue path. Returns `null` if disabled or
   * unresolvable.
   */
  private getQueuePath(): string | null {
    if (this.queuePath === undefined) {
      this.queuePath = resolveTelemetryQueuePath();
    }
    return this.queuePath;
  }

  /**
   * Append a single event to the on-disk queue. Serialized via the write
   * chain. Errors are swallowed.
   */
  private enqueueOnDisk(event: TelemetryEvent): void {
    const path = this.getQueuePath();
    if (!path) return;
    this.queueWriteChain = this.queueWriteChain
      .then(async () => {
        try {
          mkdirSync(dirname(path), { recursive: true });
          await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
        } catch {
          // Best-effort: telemetry must never break user-facing behavior.
        }
      })
      .catch(() => {
        // Defensive — the inner catch already swallows, but ensure the
        // chain itself never rejects.
      });
  }

  /**
   * Drain the on-disk queue into the in-memory queue at startup. This is
   * how events from previous crashed sessions get retried. Errors are
   * swallowed; a malformed line is skipped.
   */
  private async drainQueueFromDisk(): Promise<void> {
    const path = this.getQueuePath();
    if (!path) return;

    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      // No queue file yet — nothing to drain.
      return;
    }

    const replayed: TelemetryEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as TelemetryEvent;
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof parsed.type === "string" &&
          typeof parsed.timestamp === "string"
        ) {
          replayed.push(parsed);
        }
      } catch {
        // Skip malformed line.
      }
    }

    if (replayed.length === 0) {
      // File existed but was empty/all-malformed — delete it.
      await rm(path, { force: true }).catch(() => {});
      return;
    }

    // Prepend replayed events so they get retried before any new ones
    // recorded during init (e.g. session_start).
    this.events.unshift(...replayed);
  }

  /**
   * Rewrite the disk queue to reflect the current in-memory events. Called
   * after a successful flush to remove the just-flushed events. Serialized
   * via the write chain. Errors are swallowed.
   */
  private rewriteQueueOnDisk(): void {
    const path = this.getQueuePath();
    if (!path) return;
    const snapshot = [...this.events];
    this.queueWriteChain = this.queueWriteChain
      .then(async () => {
        try {
          if (snapshot.length === 0) {
            await rm(path, { force: true });
            return;
          }
          mkdirSync(dirname(path), { recursive: true });
          const body = `${snapshot
            .map((event) => JSON.stringify(event))
            .join("\n")}\n`;
          await writeFile(path, body, "utf8");
        } catch {
          // Best-effort.
        }
      })
      .catch(() => {});
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
