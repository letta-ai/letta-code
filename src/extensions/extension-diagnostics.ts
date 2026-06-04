import type {
  ExtensionDiagnostic,
  ExtensionDiagnosticPhase,
  ExtensionOwner,
} from "@/extensions/types";

export type ExtensionDiagnosticSeverity = "error" | "warning";

export interface ExtensionDiagnosticCollector {
  diagnostics: ExtensionDiagnostic[];
}

export interface ExtensionDiagnosticAgentEntry {
  capability?: ExtensionDiagnostic["capability"];
  errorName: string;
  extension: ExtensionOwner;
  message: string;
  phase: ExtensionDiagnosticPhase;
  severity: ExtensionDiagnosticSeverity;
  source: "host";
  stack?: string;
  timestamp: number;
}

export interface ExtensionDiagnosticsAgentReport {
  diagnostics: ExtensionDiagnosticAgentEntry[];
  errorCount: number;
  warningCount: number;
}

export interface ExtensionDiagnosticsAgentReportOptions {
  includeStack?: boolean;
}

export function getExtensionDiagnosticSeverity(
  phase: ExtensionDiagnosticPhase,
): ExtensionDiagnosticSeverity {
  switch (phase) {
    case "command_override":
      return "warning";
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
  diagnostic: Pick<ExtensionDiagnostic, "phase">,
): boolean {
  return isExtensionDiagnosticErrorPhase(diagnostic.phase);
}

export function getExtensionErrorDiagnostics(
  diagnostics: readonly ExtensionDiagnostic[],
): ExtensionDiagnostic[] {
  return diagnostics.filter(isExtensionDiagnosticError);
}

export function createExtensionDiagnosticsAgentReport(
  diagnostics: readonly ExtensionDiagnostic[],
  options: ExtensionDiagnosticsAgentReportOptions = {},
): ExtensionDiagnosticsAgentReport {
  let errorCount = 0;
  let warningCount = 0;

  const entries = diagnostics.map((diagnostic) => {
    const severity = getExtensionDiagnosticSeverity(diagnostic.phase);
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
      source: "host",
      ...(options.includeStack && diagnostic.error.stack
        ? { stack: diagnostic.error.stack }
        : {}),
      timestamp: diagnostic.timestamp,
    } satisfies ExtensionDiagnosticAgentEntry;
  });

  return {
    diagnostics: entries,
    errorCount,
    warningCount,
  };
}

function formatDiagnosticCount(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function formatDiagnosticMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

export function formatExtensionDiagnosticsForAgent(
  diagnostics: readonly ExtensionDiagnostic[],
  options: ExtensionDiagnosticsAgentReportOptions = {},
): string {
  const report = createExtensionDiagnosticsAgentReport(diagnostics, options);
  if (report.diagnostics.length === 0) {
    return "No extension diagnostics recorded.";
  }

  const lines = [
    `Extension diagnostics: ${formatDiagnosticCount(report.errorCount, "error")}, ${formatDiagnosticCount(report.warningCount, "warning")}`,
  ];

  for (const diagnostic of report.diagnostics) {
    const capability = diagnostic.capability
      ? ` ${diagnostic.capability.kind}:${diagnostic.capability.id}`
      : "";
    lines.push(
      `- [${diagnostic.severity}] ${diagnostic.phase}${capability} ${diagnostic.extension.path}`,
      `  message: ${formatDiagnosticMessage(diagnostic.message)}`,
    );
    if (diagnostic.stack) {
      lines.push(
        "  stack:",
        ...diagnostic.stack.split("\n").map((line) => `    ${line}`),
      );
    }
  }

  return lines.join("\n");
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
