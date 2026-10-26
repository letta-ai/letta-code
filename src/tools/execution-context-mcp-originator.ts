/**
 * Rebinding for a live tool execution context's MCP originator id.
 *
 * A turn parked on an approval keeps executing with the tool context frozen
 * at park time. When that continuation consumes a queued turn from another
 * super run (or an unattributed one), the token-store swap alone is not a
 * stable boundary: a late redelivery repopulating the parked run's deleted
 * key would be picked up by the very next tool call, since per-call lookups
 * read this frozen context. Rebinding the context to the consumed turn's
 * origin (or clearing it) makes the swap authoritative.
 */
import { getExecutionContextById } from "@/tools/manager";

/**
 * Rebind the originator id on a live execution context (null clears it).
 * Returns false when the context id is unknown (e.g. already pruned).
 */
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

/**
 * Rebind a live turn's tool context after it consumed a queued turn, when
 * the consumed turn's origin differs from what the context was frozen with.
 * No-op for a missing context id or an unchanged origin.
 */
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
