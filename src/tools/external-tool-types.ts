export const EXTERNAL_TOOL_FOREGROUND_INTERRUPTED =
  "external_tool_foreground_interrupted";

export interface ClientTool {
  name: string;
  description?: string | null;
  parameters?: { [key: string]: unknown } | null;
}

export interface ExternalToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  timeoutMs?: number;
  autoBackground?: boolean;
  registrationKey?: string;
  connectionId?: string;
  supportsCancellation?: boolean;
  runtime?: {
    agentId?: string;
    conversationId?: string;
  };
  executor?: ExternalToolExecutor;
}

export type ExternalToolExecutor = (
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
  context?: {
    tool: ExternalToolDefinition;
    signal?: AbortSignal;
    turnStartedAt?: number;
  },
) => Promise<{
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError: boolean;
  cancellation?: "cancelled" | "timeout";
}>;
