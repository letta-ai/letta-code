import type { RuntimeContextSnapshot } from "@/runtime-context";

interface RuntimeScopedExternalTool {
  name: string;
  connectionId?: string;
  scopeId?: string;
  runtime?: {
    agentId?: string;
    conversationId?: string;
  };
}

export function filterExternalToolsByRuntimeContext<
  TTool extends RuntimeScopedExternalTool,
>(
  externalTools: Map<string, TTool>,
  runtimeContext: RuntimeContextSnapshot,
  externalToolScopeIds?: string[],
): Map<string, TTool> {
  const matchesRuntime = (tool: TTool): boolean =>
    !tool.runtime ||
    (tool.runtime.agentId === runtimeContext.agentId &&
      tool.runtime.conversationId === runtimeContext.conversationId);
  const directlyOwnedToolNames = new Set(
    Array.from(externalTools.values())
      .filter(
        (tool) =>
          tool.connectionId === runtimeContext.connectionId &&
          matchesRuntime(tool),
      )
      .map((tool) => tool.name),
  );

  return new Map(
    Array.from(externalTools.entries()).filter(([, tool]) => {
      if (!matchesRuntime(tool)) return false;
      if (
        tool.connectionId === undefined ||
        tool.connectionId === runtimeContext.connectionId
      ) {
        return true;
      }
      return (
        tool.scopeId !== undefined &&
        externalToolScopeIds?.includes(tool.scopeId) === true &&
        !directlyOwnedToolNames.has(tool.name)
      );
    }),
  );
}
