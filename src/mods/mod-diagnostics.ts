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
    case "report":
      return severity ?? "error";
    default:
      return "error";
  }
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
