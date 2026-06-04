import type {
  ExtensionDiagnostic,
  ExtensionDiagnosticPhase,
  ExtensionOwner,
} from "@/extensions/types";

export type ExtensionDiagnosticSeverity = "error" | "warning";

export interface ExtensionDiagnosticSink {
  diagnostics: ExtensionDiagnostic[];
  errors: Array<{
    error: Error;
    owner?: ExtensionOwner;
    path: string;
    phase?: ExtensionDiagnosticPhase;
  }>;
}

export function getExtensionDiagnosticSeverity(
  phase: ExtensionDiagnosticPhase,
): ExtensionDiagnosticSeverity {
  switch (phase) {
    case "command.override":
    case "status.evaluate":
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

export function appendExtensionDiagnostic(
  registry: ExtensionDiagnosticSink,
  diagnostic: ExtensionDiagnostic,
): void {
  registry.diagnostics.push(diagnostic);
  if (isExtensionDiagnosticErrorPhase(diagnostic.phase)) {
    registry.errors.push({
      error: diagnostic.error,
      ...(diagnostic.owner ? { owner: diagnostic.owner } : {}),
      path: diagnostic.path ?? diagnostic.owner?.path ?? "",
      phase: diagnostic.phase,
    });
  }
}

export function recordExtensionDiagnostic(
  registry: ExtensionDiagnosticSink,
  diagnostic: Omit<ExtensionDiagnostic, "timestamp">,
  onDiagnostic?: (diagnostic: ExtensionDiagnostic) => void,
): ExtensionDiagnostic {
  const completeDiagnostic: ExtensionDiagnostic = {
    ...diagnostic,
    timestamp: Date.now(),
  };
  appendExtensionDiagnostic(registry, completeDiagnostic);
  onDiagnostic?.(completeDiagnostic);
  return completeDiagnostic;
}

export function recordStaleHandleUse(
  registry: ExtensionDiagnosticSink,
  owner: ExtensionOwner,
  capability: ExtensionDiagnostic["capability"],
  onDiagnostic?: (diagnostic: ExtensionDiagnostic) => void,
): ExtensionDiagnostic {
  return recordExtensionDiagnostic(
    registry,
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
