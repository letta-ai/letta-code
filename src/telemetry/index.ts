import { settingsManager } from "../settings-manager";

export interface TelemetryEvent {
  type: "session_start" | "session_end" | "tool_usage" | "error" | "agent_interaction";
  timestamp: string;
  data: Record<string, unknown>;
}

export interface SessionStartData {
  version: string;
  platform: string;
  nodeVersion: string;
}

export interface SessionEndData {
  duration: number; // in seconds
  messageCount: number;
  toolCallCount: number;
}

export interface ToolUsageData {
  toolName: string;
  success: boolean;
  duration?: number;
  errorType?: string;
}

export interface ErrorData {
  errorType: string;
  errorMessage: string;
  context?: string;
  stack?: string;
}

export interface AgentInteractionData {
  action: "create" | "select" | "message" | "delete";
  agentId?: string;
  messageType?: string;
}

class TelemetryManager {
  private events: TelemetryEvent[] = [];
  private sessionId: string;
  private sessionStartTime: number;
  private messageCount = 0;
  private toolCallCount = 0;
  private flushInterval: NodeJS.Timeout | null = null;
  private readonly FLUSH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_BATCH_SIZE = 100;

  constructor() {
    this.sessionId = this.generateSessionId();
    this.sessionStartTime = Date.now();
  }

  private generateSessionId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  }

  /**
   * Check if telemetry is enabled based on user settings
   */
  private isTelemetryEnabled(): boolean {
    const settings = settingsManager.getSettings();
    // Default to enabled if not explicitly disabled
    return settings.telemetryEnabled !== false;
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

    // Flush on process exit
    process.on("exit", () => {
      this.trackSessionEnd();
      // Synchronous flush on exit
      this.flushSync().catch(() => {
        // Ignore errors on exit
      });
    });

    process.on("SIGINT", () => {
      this.trackSessionEnd();
      this.flushSync().catch(() => {
        // Ignore errors
      });
      process.exit(0);
    });
  }

  /**
   * Track a telemetry event
   */
  private track(type: TelemetryEvent["type"], data: Record<string, unknown>) {
    if (!this.isTelemetryEnabled()) {
      return;
    }

    const event: TelemetryEvent = {
      type,
      timestamp: new Date().toISOString(),
      data: {
        ...data,
        sessionId: this.sessionId,
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
   * Track session start
   */
  trackSessionStart() {
    const data: SessionStartData = {
      version: process.env.npm_package_version || "unknown",
      platform: process.platform,
      nodeVersion: process.version,
    };
    this.track("session_start", data);
  }

  /**
   * Track session end
   */
  trackSessionEnd() {
    const duration = Math.floor((Date.now() - this.sessionStartTime) / 1000);
    const data: SessionEndData = {
      duration,
      messageCount: this.messageCount,
      toolCallCount: this.toolCallCount,
    };
    this.track("session_end", data);
  }

  /**
   * Track tool usage
   */
  trackToolUsage(toolName: string, success: boolean, duration?: number, errorType?: string) {
    this.toolCallCount++;
    const data: ToolUsageData = {
      toolName,
      success,
      duration,
      errorType,
    };
    this.track("tool_usage", data);
  }

  /**
   * Track errors
   */
  trackError(errorType: string, errorMessage: string, context?: string, stack?: string) {
    const data: ErrorData = {
      errorType,
      errorMessage,
      context,
      stack: stack?.substring(0, 500), // Limit stack trace length
    };
    this.track("error", data);
  }

  /**
   * Track agent interactions
   */
  trackAgentInteraction(
    action: AgentInteractionData["action"],
    agentId?: string,
    messageType?: string,
  ) {
    if (action === "message") {
      this.messageCount++;
    }
    const data: AgentInteractionData = {
      action,
      agentId,
      messageType,
    };
    this.track("agent_interaction", data);
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
      const settings = settingsManager.getSettings();
      const baseURL =
        process.env.LETTA_BASE_URL ||
        settings.env?.LETTA_BASE_URL ||
        "https://api.letta.com";
      const apiKey = process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;

      const response = await fetch(`${baseURL}/v1/metadata/telemetry`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "X-Letta-Source": "letta-code",
        },
        body: JSON.stringify({
          service: 'letta-code',
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
