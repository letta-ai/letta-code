import { getExecutionContextById } from "@/tools/manager";

export function updateToolExecutionContextMcpOriginator(
  contextId: string,
  mcpOriginatorSuperRunId: string | null,
): boolean {
  const context = getExecutionContextById(contextId);
  if (!context) {
    return false;
  }
  context.runtimeContext.mcpOriginatorSuperRunId = mcpOriginatorSuperRunId;
  return true;
}

export function rebindTurnToolContextMcpOriginator(
  turnToolContextId: string | null,
  mcpOriginatorSuperRunId: string | undefined,
): void {
  if (!turnToolContextId) return;
  const context = getExecutionContextById(turnToolContextId);
  if (!context) return;
  const next = mcpOriginatorSuperRunId ?? null;
  if (context.runtimeContext.mcpOriginatorSuperRunId === next) return;
  context.runtimeContext.mcpOriginatorSuperRunId = next;
}
