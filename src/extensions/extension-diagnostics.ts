import type {
  ExtensionDiagnostic,
  ExtensionDiagnosticPhase,
  ExtensionDiagnosticSeverity,
  ExtensionOwner,
} from "@/extensions/types";

export type { ExtensionDiagnosticSeverity } from "@/extensions/types";

export interface ExtensionDiagnosticCollector {
  diagnostics: ExtensionDiagnostic[];
}

export interface ExtensionDiagnosticReportEntry {
  capability?: ExtensionDiagnostic["capability"];
  errorName: string;
  extension: ExtensionOwner;
  message: string;
  phase: ExtensionDiagnosticPhase;
  severity: ExtensionDiagnosticSeverity;
  stack?: string;
  timestamp: number;
}

export interface ExtensionDiagnosticsReport {
  diagnostics: ExtensionDiagnosticReportEntry[];
  errorCount: number;
  warningCount: number;
}

export function getExtensionDiagnosticSeverity(
  phase: ExtensionDiagnosticPhase,
  severity?: ExtensionDiagnosticSeverity,
): ExtensionDiagnosticSeverity {
  switch (phase) {
    case "command_override":
      return "warning";
    case "report":
      return severity ?? "error";
    default:
      return "error";
  }
}

export function isExtensionDiagnosticErrorPhase(
  phase: ExtensionDiagnosticPhase,
): boolean {
  return getExtensionDiagnosticSeverity(phase) === "error";
}

export function isExtensionDiagnosticError(
  diagnostic: Pick<ExtensionDiagnostic, "phase" | "severity">,
): boolean {
  return (
    getExtensionDiagnosticSeverity(diagnostic.phase, diagnostic.severity) ===
    "error"
  );
}

export function getExtensionErrorDiagnostics(
  diagnostics: readonly ExtensionDiagnostic[],
): ExtensionDiagnostic[] {
  return diagnostics.filter(isExtensionDiagnosticError);
}

export function createExtensionDiagnosticsReport(
  diagnostics: readonly ExtensionDiagnostic[],
): ExtensionDiagnosticsReport {
  let errorCount = 0;
  let warningCount = 0;

  const entries = diagnostics.map((diagnostic) => {
    const severity = getExtensionDiagnosticSeverity(
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
      extension: { ...diagnostic.owner },
      message: diagnostic.error.message,
      phase: diagnostic.phase,
      severity,
      ...(diagnostic.error.stack ? { stack: diagnostic.error.stack } : {}),
      timestamp: diagnostic.timestamp,
    } satisfies ExtensionDiagnosticReportEntry;
  });

  return {
    diagnostics: entries,
    errorCount,
    warningCount,
  };
}

export function appendExtensionDiagnostic(
  collector: ExtensionDiagnosticCollector,
  diagnostic: ExtensionDiagnostic,
): void {
  collector.diagnostics.push(diagnostic);
}

export function recordExtensionDiagnostic(
  collector: ExtensionDiagnosticCollector,
  diagnostic: Omit<ExtensionDiagnostic, "timestamp">,
  onDiagnostic?: (diagnostic: ExtensionDiagnostic) => void,
): ExtensionDiagnostic {
  const completeDiagnostic: ExtensionDiagnostic = {
    ...diagnostic,
    timestamp: Date.now(),
  };
  appendExtensionDiagnostic(collector, completeDiagnostic);
  onDiagnostic?.(completeDiagnostic);
  return completeDiagnostic;
}

export function recordStaleHandleUse(
  collector: ExtensionDiagnosticCollector,
  owner: ExtensionOwner,
  capability: ExtensionDiagnostic["capability"],
  onDiagnostic?: (diagnostic: ExtensionDiagnostic) => void,
): ExtensionDiagnostic {
  return recordExtensionDiagnostic(
    collector,
    {
      capability,
      error: new Error(
        `Ignored stale extension handle for ${capability?.kind ?? "capability"}${capability?.id ? ` '${capability.id}'` : ""}`,
      ),
      owner,
      phase: "stale_handle",
    },
    onDiagnostic,
  );
}
