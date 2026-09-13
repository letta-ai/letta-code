import type { ModDiagnostic } from "@/mods/types";

export type DeprecatedApiDiagnosticRecorder = (
  diagnostic: Pick<
    ModDiagnostic,
    "capability" | "error" | "phase" | "severity"
  >,
) => void;

const STATUSLINE_MIGRATION =
  "The statusline mod APIs (setStatus / clearStatus / setStatuslineRenderer) have been removed. Use letta.ui.openPanel({ id, order, render }) instead: order 0 is the primary line (replaces the built-in agent · model line), order 1 replaces the default product-status row, orders > 1 render additive panels above the input, and negative orders stack below the primary line. render(ctx) returns a string; use ctx.row / ctx.columns for layout and ctx.chalk for color.";

function createDeprecatedApiError(apiId: string): Error {
  if (apiId === "letta.getContext") {
    return new Error(
      "letta.getContext is no longer available. Activation has no dynamic invocation context. Move dynamic work into a callback that receives ctx, or use explicit/global state such as process.cwd() for activation-time background work.",
    );
  }
  if (apiId === "ctx.getContext") {
    return new Error(
      "ctx.getContext is no longer available. Use ctx directly; scoped fields are available as ctx.agent, ctx.cwd, ctx.conversation, ctx.model, etc.",
    );
  }
  if (
    apiId === "letta.ui.setStatus" ||
    apiId === "letta.ui.clearStatus" ||
    apiId === "letta.ui.setStatuslineRenderer"
  ) {
    return new Error(
      `${apiId} is no longer available. ${STATUSLINE_MIGRATION}`,
    );
  }
  return new Error(
    `${apiId} is no longer available. If this is callback ctx, use ctx directly; if activation/background code needs runtime state, move it into a callback that receives ctx or use explicit/global state such as process.cwd().`,
  );
}

export function createDeprecatedApiTrap(
  apiId: string,
  recordDiagnostic?: DeprecatedApiDiagnosticRecorder,
): () => never {
  return () => {
    const error = createDeprecatedApiError(apiId);
    recordDiagnostic?.({
      capability: { id: apiId, kind: "api" },
      error,
      phase: "deprecated_api",
      severity: "warning",
    });
    throw error;
  };
}

export function attachDeprecatedGetContextTrap<T extends object>(
  context: T,
  recordDiagnostic?: DeprecatedApiDiagnosticRecorder,
  apiId = "ctx.getContext",
): T {
  const trap = createDeprecatedApiTrap(apiId, recordDiagnostic);
  try {
    Object.defineProperty(context, "getContext", {
      configurable: true,
      enumerable: false,
      value: trap,
    });
    return context;
  } catch {
    return Object.defineProperty({ ...context }, "getContext", {
      configurable: true,
      enumerable: false,
      value: trap,
    }) as T;
  }
}

export function findDeprecatedContextApiUsages(source: string): string[] {
  const usages = new Set<string>();
  if (/\bletta\s*\.\s*getContext\b/.test(source)) {
    usages.add("letta.getContext");
  }
  if (/\bctx\s*\.\s*getContext\b/.test(source)) {
    usages.add("ctx.getContext");
  }
  if (usages.size === 0 && /\.\s*getContext\s*\(/.test(source)) {
    usages.add(".getContext()");
  }
  if (/\.\s*setStatuslineRenderer\s*\(/.test(source)) {
    usages.add("letta.ui.setStatuslineRenderer");
  }
  if (/\.\s*setStatus\s*\(/.test(source)) {
    usages.add("letta.ui.setStatus");
  }
  if (/\.\s*clearStatus\s*\(/.test(source)) {
    usages.add("letta.ui.clearStatus");
  }
  return [...usages];
}

export function recordDeprecatedContextApiSourceDiagnostics(
  source: string,
  recordDiagnostic: DeprecatedApiDiagnosticRecorder,
): void {
  for (const apiId of findDeprecatedContextApiUsages(source)) {
    const error = new Error(`Mod source uses removed API: ${apiId}`);
    error.stack = undefined;
    recordDiagnostic({
      capability: { id: apiId, kind: "api" },
      error,
      phase: "deprecated_api",
      severity: "warning",
    });
  }
}
