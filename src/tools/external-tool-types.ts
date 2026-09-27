/** Model-facing client tool definition. */
export interface ClientTool {
  name: string;
  description?: string | null;
  parameters?: { [key: string]: unknown } | null;
}

/** Tool executed by an SDK or a listener-connected controller. */
export interface ExternalToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Wait for a controller-owned result, not execution time. */
  timeoutMs?: number;
  /** Listener registrations may yield to a task notification; direct SDK calls stay inline. */
  autoBackground?: boolean;
  /** Internal registration key; model-facing calls still use name. */
  registrationKey?: string;
  connectionId?: string;
  /** Optional visibility scope; scoped tools are hidden unless selected for a turn. */
  scopeId?: string;
  /** Optional runtime owner; runtime-owned tools are visible only in that runtime. */
  runtime?: {
    agentId?: string;
    conversationId?: string;
  };
  /** Client-local executor owned by this tool (for example an MCP process). */
  executor?: ExternalToolExecutor;
}

/** Callback that asks an SDK or listener controller to execute a tool. */
export type ExternalToolExecutor = (
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
  context?: { tool: ExternalToolDefinition },
) => Promise<{
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError: boolean;
}>;
