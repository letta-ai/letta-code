type McpOriginatorTokenResolver = (
  superRunId: string | null | undefined,
) => string | undefined;

const RESOLVER_KEY = Symbol.for("@letta/mcpOriginatorTokenResolver");

type GlobalWithMcpOriginatorResolver = typeof globalThis & {
  [RESOLVER_KEY]?: McpOriginatorTokenResolver;
};

export function registerMcpOriginatorTokenResolver(
  resolver: McpOriginatorTokenResolver,
): void {
  (globalThis as GlobalWithMcpOriginatorResolver)[RESOLVER_KEY] = resolver;
}

export function resolveMcpOriginatorToken(
  superRunId: string | null | undefined,
): string | undefined {
  return (globalThis as GlobalWithMcpOriginatorResolver)[RESOLVER_KEY]?.(
    superRunId,
  );
}
