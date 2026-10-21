import type { IncomingMessage } from "./types";

export type McpOriginatorScope = {
  superRunId: string;
  tokenPresent: boolean;
} | null;

export function getMcpOriginatorScope(
  message?: Pick<
    IncomingMessage,
    "mcpOriginatorSuperRunId" | "mcpOriginatorTokenPresent"
  >,
): McpOriginatorScope {
  return message?.mcpOriginatorSuperRunId
    ? {
        superRunId: message.mcpOriginatorSuperRunId,
        tokenPresent: message.mcpOriginatorTokenPresent === true,
      }
    : null;
}

export function sameMcpOriginatorScope(
  a: McpOriginatorScope,
  b: McpOriginatorScope,
): boolean {
  return a === null || b === null
    ? a === b
    : a.superRunId === b.superRunId && a.tokenPresent === b.tokenPresent;
}

export function getEffectiveMcpOriginatorId(
  message: Pick<
    IncomingMessage,
    "mcpOriginatorSuperRunId" | "mcpOriginatorTokenPresent"
  >,
): string | undefined {
  return message.mcpOriginatorTokenPresent === true
    ? message.mcpOriginatorSuperRunId
    : undefined;
}
