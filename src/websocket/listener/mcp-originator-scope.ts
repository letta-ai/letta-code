import type { IncomingMessage } from "./types";

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
