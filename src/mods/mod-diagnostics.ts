import type {
  ModDiagnostic,
  ModDiagnosticPhase,
  ModDiagnosticSeverity,
  ModOwner,
} from "@/mods/types";

export type { ModDiagnosticSeverity } from "@/mods/types";

export const MOD_DIAGNOSTICS_MAX_COUNT = 200;
export const MOD_DIAGNOSTICS_RESET_COUNT = 50;

export interface ModDiagnosticCollector {
  diagnostics: ModDiagnostic[];
}

export interface ModDiagnosticReportEntry {
  capability?: ModDiagnostic["capability"];
  errorName: string;
  hint?: string;
  mod: ModOwner;
  message: string;
  phase: ModDiagnosticPhase;
  severity: ModDiagnosticSeverity;
  stack?: string;
  timestamp: number;
}

export interface ModDiagnosticsReport {
  diagnostics: ModDiagnosticReportEntry[];
  errorCount: number;
  warningCount: number;
}

export function getModDiagnosticSeverity(
  phase: ModDiagnosticPhase,
  severity?: ModDiagnosticSeverity,
): ModDiagnosticSeverity {
  switch (phase) {
    case "command_override":
      return "warning";
    case "deprecated_api":
    case "legacy_extension":
      return severity ?? "warning";
    case "report":
      return severity ?? "error";
    default:
      return "error";
  }
}

export const MOD_DYNAMIC_CONTEXT_MIGRATION_HINT =
  "Dynamic context is now passed as ctx to commands, tools, events, permissions, and UI renderers. Use ctx.agent, ctx.cwd, ctx.conversation, ctx.model, etc.";

export const MOD_LETTA_GET_CONTEXT_MIGRATION_HINT =
  "letta.getContext has been removed. Activation has no dynamic invocation context. Move dynamic work into a command, tool, event, permission, status, or statusline callback that receives ctx, or use explicit/global state such as process.cwd() for activation-time background work.";

export const MOD_CTX_GET_CONTEXT_MIGRATION_HINT =
  "ctx.getContext has been removed. Use ctx directly; scoped fields are available as ctx.agent, ctx.cwd, ctx.conversation, ctx.model, etc.";

export const MOD_GENERIC_GET_CONTEXT_MIGRATION_HINT =
  "getContext helpers have been removed. If this is callback ctx, use ctx directly; if activation/background code needs runtime state, move it into a callback that receives ctx or use explicit/global state such as process.cwd().";

export const MOD_PANEL_CONTEXT_MIGRATION_HINT =
  "UI panels now receive ModContext plus panel helpers (ctx.width, ctx.row, ctx.columns, ctx.chalk). Old statusline renderer fields like ctx.components, ctx.statuses, ctx.rawPayload, and ctx.ui are no longer available.";

function getDeprecatedApiDiagnosticHint(
  diagnostic: Pick<ModDiagnostic, "capability">,
): string {
  if (diagnostic.capability?.kind === "api") {
    switch (diagnostic.capability.id) {
      case "letta.getContext":
        return MOD_LETTA_GET_CONTEXT_MIGRATION_HINT;
      case "ctx.getContext":
        return MOD_CTX_GET_CONTEXT_MIGRATION_HINT;
      default:
        return MOD_GENERIC_GET_CONTEXT_MIGRATION_HINT;
    }
  }
  return MOD_DYNAMIC_CONTEXT_MIGRATION_HINT;
}

export function getModDiagnosticHint(
  diagnostic: Pick<ModDiagnostic, "capability" | "error" | "phase">,
): string | undefined {
  if (diagnostic.phase === "deprecated_api") {
    return getDeprecatedApiDiagnosticHint(diagnostic);
  }
  const message = diagnostic.error.message.toLowerCase();
  if (
    diagnostic.phase === "panel.render" &&
    (message.includes("components") ||
      message.includes("statuses") ||
      message.includes("rawpayload") ||
      message.includes("raw payload") ||
      message.includes("ctx.ui") ||
      message.includes("context.ui"))
  ) {
    return MOD_PANEL_CONTEXT_MIGRATION_HINT;
  }
  if (
    message.includes("getcontext") &&
    (message.includes("not a function") ||
      message.includes("undefined") ||
      message.includes("cannot read") ||
      message.includes("no longer available"))
  ) {
    return MOD_DYNAMIC_CONTEXT_MIGRATION_HINT;
  }
  return undefined;
}

export function isModDiagnosticErrorPhase(phase: ModDiagnosticPhase): boolean {
  return getModDiagnosticSeverity(phase) === "error";
}

export function isModDiagnosticError(
  diagnostic: Pick<ModDiagnostic, "phase" | "severity">,
): boolean {
  return (
    getModDiagnosticSeverity(diagnostic.phase, diagnostic.severity) === "error"
  );
}

export function getModErrorDiagnostics(
  diagnostics: readonly ModDiagnostic[],
): ModDiagnostic[] {
  return diagnostics.filter(isModDiagnosticError);
}

export function createModDiagnosticsReport(
  diagnostics: readonly ModDiagnostic[],
): ModDiagnosticsReport {
  let errorCount = 0;
  let warningCount = 0;

  const entries = diagnostics.map((diagnostic) => {
    const severity = getModDiagnosticSeverity(
      diagnostic.phase,
      diagnostic.severity,
    );
    const hint = getModDiagnosticHint(diagnostic);
    if (severity === "error") {
      errorCount += 1;
    } else {
      warningCount += 1;
    }

    return {
      ...(diagnostic.capability
        ? { capability: { ...diagnostic.capability } }
        : {}),
      errorName: diagnostic.error.name,
      ...(hint ? { hint } : {}),
      mod: { ...diagnostic.owner },
      message: diagnostic.error.message,
      phase: diagnostic.phase,
      severity,
      ...(diagnostic.error.stack ? { stack: diagnostic.error.stack } : {}),
      timestamp: diagnostic.timestamp,
    } satisfies ModDiagnosticReportEntry;
  });

  return {
    diagnostics: entries,
    errorCount,
    warningCount,
  };
}

export function appendModDiagnostic(
  collector: ModDiagnosticCollector,
  diagnostic: ModDiagnostic,
): void {
  collector.diagnostics.push(diagnostic);
  if (collector.diagnostics.length > MOD_DIAGNOSTICS_MAX_COUNT) {
    collector.diagnostics.splice(
      0,
      collector.diagnostics.length - MOD_DIAGNOSTICS_RESET_COUNT,
    );
  }
}

export function recordModDiagnostic(
  collector: ModDiagnosticCollector,
  diagnostic: Omit<ModDiagnostic, "timestamp">,
  onDiagnostic?: (diagnostic: ModDiagnostic) => void,
): ModDiagnostic {
  const completeDiagnostic: ModDiagnostic = {
    ...diagnostic,
    timestamp: Date.now(),
  };
  appendModDiagnostic(collector, completeDiagnostic);
  onDiagnostic?.(completeDiagnostic);
  return completeDiagnostic;
}

export function recordStaleHandleUse(
  collector: ModDiagnosticCollector,
  owner: ModOwner,
  capability: ModDiagnostic["capability"],
  onDiagnostic?: (diagnostic: ModDiagnostic) => void,
): ModDiagnostic {
  return recordModDiagnostic(
    collector,
    {
      capability,
      error: new Error(
        `Ignored stale mod handle for ${capability?.kind ?? "capability"}${capability?.id ? ` '${capability.id}'` : ""}`,
      ),
      owner,
      phase: "stale_handle",
    },
    onDiagnostic,
  );
}
