import { getMcpOriginatorToken } from "@/agent/mcp-originator-tokens";
import { getRuntimeContext } from "@/runtime-context";

/**
 * Originator token held for the current listener turn's cloud super run, if
 * any. Server-side MCP discovery (list, tools, search) and execution all send
 * it, so a restricted server and its tools are visible exactly when the turn's
 * originator may use them. In-memory store lookup only; never logged.
 */
export function currentMcpOriginatorToken(): string | undefined {
  return getMcpOriginatorToken(getRuntimeContext()?.mcpOriginatorSuperRunId);
}

/** Options fragment for the unified MCP discovery calls. */
export function mcpOriginatorOptions(): { originatorToken?: string } {
  const originatorToken = currentMcpOriginatorToken();
  return originatorToken ? { originatorToken } : {};
}

/**
 * Token for an MCP tool run. Unattributed callers get none and the header is
 * omitted. A turn attributed to a super run that holds no token is expected
 * after a listener restart, when the durable ledger replays an acknowledged
 * input but the memory-only token store was cleared. The call proceeds
 * without the header and the server fails closed on any restricted
 * connection; the loss is surfaced so it is never silent.
 */
export function mcpOriginatorTokenForToolRun(): string | undefined {
  const superRunId = getRuntimeContext()?.mcpOriginatorSuperRunId;
  const originatorToken = currentMcpOriginatorToken();
  if (superRunId && !originatorToken) {
    console.warn(
      `[mcp-originator] no originator token held for super run ${superRunId}; running tool call unattributed (expected after listener restart)`,
    );
  }
  return originatorToken;
}
