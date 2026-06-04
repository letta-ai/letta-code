import type {
  ExtensionDiagnostic,
  ExtensionDiagnosticPhase,
  ExtensionOwner,
} from "@/extensions/types";

export type ExtensionDiagnosticSeverity = "error" | "warning";

export interface ExtensionDiagnosticCollector {
  diagnostics: ExtensionDiagnostic[];
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

export function getExtensionDiagnosticPath(
  diagnostic: Pick<ExtensionDiagnostic, "owner" | "path">,
): string {
  return diagnostic.path ?? diagnostic.owner?.path ?? "";
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
      path: owner.path,
      phase: "stale_handle",
    },
    onDiagnostic,
  );
}
