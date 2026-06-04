import { describe, expect, test } from "bun:test";
import {
  type ExtensionDiagnosticSink,
  getExtensionDiagnosticSeverity,
  recordExtensionDiagnostic,
} from "@/extensions/extension-diagnostics";
import type { ExtensionDiagnostic, ExtensionOwner } from "@/extensions/types";

function createOwner(): ExtensionOwner {
  return {
    generation: 1,
    id: "global:/tmp/example.ts",
    path: "/tmp/example.ts",
    scope: "global",
  };
}

describe("extension diagnostics", () => {
  test("classifies diagnostic phases for future surfacing", () => {
    expect(getExtensionDiagnosticSeverity("command.override")).toBe("warning");
    expect(getExtensionDiagnosticSeverity("status.evaluate")).toBe("warning");
    expect(getExtensionDiagnosticSeverity("activate")).toBe("error");
    expect(getExtensionDiagnosticSeverity("event")).toBe("error");
  });

  test("records diagnostics and only mirrors error phases into errors", () => {
    const registry: ExtensionDiagnosticSink = { diagnostics: [], errors: [] };
    const owner = createOwner();
    const seen: ExtensionDiagnostic[] = [];

    const warning = recordExtensionDiagnostic(
      registry,
      {
        capability: { id: "reload", kind: "command" },
        error: new Error("command override"),
        owner,
        path: owner.path,
        phase: "command.override",
      },
      (diagnostic) => seen.push(diagnostic),
    );
    const error = recordExtensionDiagnostic(registry, {
      error: new Error("activation failed"),
      owner,
      path: owner.path,
      phase: "activate",
    });

    expect(registry.diagnostics).toEqual([warning, error]);
    expect(registry.errors).toEqual([
      {
        error: error.error,
        owner,
        path: owner.path,
        phase: "activate",
      },
    ]);
    expect(seen).toEqual([warning]);
    expect(warning.timestamp).toEqual(expect.any(Number));
    expect(error.timestamp).toEqual(expect.any(Number));
  });
});
