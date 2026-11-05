type McpOriginatorTokenResolver = (
  superRunId: string | null | undefined,
) => string | undefined;

const RESOLVER_KEY = Symbol.for("@letta/mcpOriginatorTokenResolver");

type GlobalWithMcpOriginatorResolver = typeof globalThis & {
  [RESOLVER_KEY]?: McpOriginatorTokenResolver;
};

/**
 * Register the agent-layer resolver without making lower layers import the
 * originator token store. The resolver performs the store's durable use-time
 * authority check on every call.
 */
export function registerMcpOriginatorTokenResolver(
  resolver: McpOriginatorTokenResolver,
): void {
  (globalThis as GlobalWithMcpOriginatorResolver)[RESOLVER_KEY] = resolver;
}

/** Resolve the current bearer for one super run, or no authority. */
export function resolveMcpOriginatorToken(
  superRunId: string | null | undefined,
): string | undefined {
  return (globalThis as GlobalWithMcpOriginatorResolver)[RESOLVER_KEY]?.(
    superRunId,
  );
}
