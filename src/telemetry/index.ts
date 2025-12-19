export interface TelemetryEvent {
  type: "session_start" | "session_end" | "tool_usage" | "error" | "user_input";
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
  cached_tokens?: number;
  reasoning_tokens?: number;
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
}

export interface UserInputData {
  input_length: number;
  is_command: boolean;
  command_name?: string;
  message_type: string;
}

class TelemetryManager {
  private events: TelemetryEvent[] = [];
  private sessionId: string;
  private currentAgentId: string | null = null;
  private sessionStartTime: number;
  private messageCount = 0;
  private toolCallCount = 0;
  private sessionEndTracked = false;
  private flushInterval: NodeJS.Timeout | null = null;
  private readonly FLUSH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_BATCH_SIZE = 100;
  private sessionStatsGetter?: () => {
    totalWallMs: number;
    totalApiMs: number;
    usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      cachedTokens: number;
      reasoningTokens: number;
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

    // Disable telemetry if using self-hosted server (not api.letta.com)
    const baseURL = process.env.LETTA_BASE_URL;
    if (baseURL && !baseURL.includes("api.letta.com")) {
      return false;
    }

    return true;
  }

  /**
   * Initialize telemetry and start periodic flushing
   */
  init() {
    if (!this.isTelemetryEnabled()) {
      return;
    }

    this.trackSessionStart();

    // Set up periodic flushing
    this.flushInterval = setInterval(() => {
      this.flush().catch((err) => {
        // Silently fail - we don't want telemetry to interfere with user experience
        if (process.env.LETTA_DEBUG) {
          console.error("Telemetry flush error:", err);
        }
      });
    }, this.FLUSH_INTERVAL_MS);

    // Safety net: Track session end on process exit (in case handleExit wasn't called)
    // Note: handleExit in App.tsx should call trackSessionEnd() explicitly for normal exits
    process.on("exit", () => {
      this.trackSessionEnd(undefined, "process_exit");
      // Synchronous flush on exit
      this.flushSync().catch(() => {
        // Ignore errors on exit
      });
    });

    // Safety net: Handle Ctrl+C interruption
    process.on("SIGINT", () => {
      this.trackSessionEnd(undefined, "sigint");
      this.flushSync().catch(() => {
        // Ignore errors
      });
      process.exit(0);
    });
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
      | UserInputData,
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
        cachedTokens: number;
        reasoningTokens: number;
        stepCount: number;
      };
    },
  ) {
    this.sessionStatsGetter = getter;
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
      version: process.env.npm_package_version || "unknown",
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
        cachedTokens: number;
        reasoningTokens: number;
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
      cached_tokens: sessionStats?.usage.cachedTokens,
      reasoning_tokens: sessionStats?.usage.reasoningTokens,
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
    },
  ) {
    const data: ErrorData = {
      error_type: errorType,
      error_message: errorMessage,
      context,
      http_status: options?.httpStatus,
      model_id: options?.modelId,
    };
    this.track("error", data);
  }

  /**
   * Track user input
   * Note: agent_id is automatically added from currentAgentId
   */
  trackUserInput(input: string, messageType: string) {
    this.messageCount++;

    const isCommand = input.trim().startsWith("/");
    const commandName = isCommand ? input.trim().split(/\s+/)[0] : undefined;

    const data: UserInputData = {
      input_length: input.length,
      is_command: isCommand,
      command_name: commandName,
      message_type: messageType,
    };
    this.track("user_input", data);
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

    try {
      const baseURL = process.env.LETTA_BASE_URL || "https://api.letta.com";
      const apiKey = process.env.LETTA_API_KEY;

      const response = await fetch(`${baseURL}/v1/metadata/telemetry`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "X-Letta-Source": "letta-code",
        },
        body: JSON.stringify({
          service: "letta-code",
          events: eventsToSend,
        }),
      });

      if (!response.ok) {
        // If flush fails, put events back in queue
        this.events.unshift(...eventsToSend);
        throw new Error(`Telemetry flush failed: ${response.status}`);
      }
    } catch (error) {
      // If flush fails, put events back in queue
      this.events.unshift(...eventsToSend);
      throw error;
    }
  }

  /**
   * Synchronous flush for process exit
   */
  private async flushSync(): Promise<void> {
    await this.flush();
  }

  /**
   * Clean up resources
   */
  cleanup() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
  }
}

// Export singleton instance
export const telemetry = new TelemetryManager();
