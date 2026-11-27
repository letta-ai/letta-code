export interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: unknown };
}

export function parseCodexMessage(line: string): JsonRpcMessage | undefined {
  try {
    const message: unknown = JSON.parse(line);
    if (message && typeof message === "object" && !Array.isArray(message)) {
      return message as JsonRpcMessage;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
export function codexServerRequestReply(
  id: number | string,
  method: string,
): JsonRpcMessage {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { id, result: { decision: "decline" } };
    case "applyPatchApproval":
    case "execCommandApproval":
      return {
        id,
        result: {
          decision: { denied: { rejection: "Approvals are disabled" } },
        },
      };
    case "item/permissions/requestApproval":
      return { id, result: { permissions: {}, scope: "turn" } };
    case "item/tool/requestUserInput":
      return { id, result: { answers: {} } };
    case "mcpServer/elicitation/request":
      return { id, result: { action: "decline", content: null, _meta: null } };
    case "item/tool/call":
      return { id, result: { success: false, contentItems: [] } };
    case "currentTime/read":
      return { id, result: { currentTimeAt: Math.floor(Date.now() / 1_000) } };
    default:
      return {
        id,
        error: {
          code: -32601,
          message: `Unsupported Codex request: ${method}`,
        },
      };
  }
}
