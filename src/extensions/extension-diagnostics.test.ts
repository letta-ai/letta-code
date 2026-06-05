import { describe, expect, test } from "bun:test";
import {
  appendExtensionDiagnostic,
  createExtensionDiagnosticsReport,
  EXTENSION_DIAGNOSTICS_MAX_COUNT,
  EXTENSION_DIAGNOSTICS_RESET_COUNT,
  type ExtensionDiagnosticCollector,
  getExtensionDiagnosticSeverity,
  getExtensionErrorDiagnostics,
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

function createError(message: string): Error {
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at extension.ts:1:1`;
  return error;
}

describe("extension diagnostics", () => {
  test("classifies diagnostic phases for future surfacing", () => {
    expect(getExtensionDiagnosticSeverity("command_override")).toBe("warning");
    expect(getExtensionDiagnosticSeverity("report")).toBe("error");
    expect(getExtensionDiagnosticSeverity("report", "warning")).toBe("warning");
    expect(getExtensionDiagnosticSeverity("report", "error")).toBe("error");
    expect(getExtensionDiagnosticSeverity("activate")).toBe("error");
    expect(getExtensionDiagnosticSeverity("event")).toBe("error");
  });

  test("records diagnostics and derives error diagnostics", () => {
    const registry: ExtensionDiagnosticCollector = {
      diagnostics: [],
    };
    const owner = createOwner();
    const seen: ExtensionDiagnostic[] = [];

    const warning = recordExtensionDiagnostic(
      registry,
      {
        capability: { id: "reload", kind: "command" },
        error: new Error("command override"),
        owner,
        phase: "command_override",
      },
      (diagnostic) => seen.push(diagnostic),
    );
    const error = recordExtensionDiagnostic(registry, {
      error: new Error("activation failed"),
      owner,
      phase: "activate",
    });

    expect(registry.diagnostics).toEqual([warning, error]);
    expect(getExtensionErrorDiagnostics(registry.diagnostics)).toEqual([error]);
    expect(seen).toEqual([warning]);
    expect(warning.timestamp).toEqual(expect.any(Number));
    expect(error.timestamp).toEqual(expect.any(Number));
  });

  test("caps diagnostics on append with hysteresis", () => {
    const registry: ExtensionDiagnosticCollector = {
      diagnostics: [],
    };
    const owner = createOwner();

    for (let index = 0; index <= EXTENSION_DIAGNOSTICS_MAX_COUNT; index += 1) {
      appendExtensionDiagnostic(registry, {
        error: new Error(`diagnostic ${index}`),
        owner,
        phase: "event",
        timestamp: index,
      });
    }

    expect(registry.diagnostics).toHaveLength(
      EXTENSION_DIAGNOSTICS_RESET_COUNT,
    );
    expect(registry.diagnostics[0]?.error.message).toBe("diagnostic 151");
    expect(registry.diagnostics.at(-1)?.error.message).toBe("diagnostic 200");

    appendExtensionDiagnostic(registry, {
      error: new Error("diagnostic 201"),
      owner,
      phase: "event",
      timestamp: 201,
    });

    expect(registry.diagnostics).toHaveLength(
      EXTENSION_DIAGNOSTICS_RESET_COUNT + 1,
    );
    expect(registry.diagnostics.at(-1)?.error.message).toBe("diagnostic 201");
  });

  test("creates compact agent reports from diagnostics", () => {
    const owner = createOwner();
    const warning: ExtensionDiagnostic = {
      capability: { id: "reload", kind: "command" },
      error: createError("command override"),
      owner,
      phase: "command_override",
      timestamp: 100,
    };
    const error: ExtensionDiagnostic = {
      error: createError("activation failed"),
      owner,
      phase: "activate",
      timestamp: 200,
    };
    const reportError = new Error("missing optional env");
    reportError.stack = undefined;
    const report: ExtensionDiagnostic = {
      error: reportError,
      owner,
      phase: "report",
      timestamp: 300,
    };

    expect(createExtensionDiagnosticsReport([warning, error, report])).toEqual({
      diagnostics: [
        {
          capability: { id: "reload", kind: "command" },
          errorName: "Error",
          extension: owner,
          message: "command override",
          phase: "command_override",
          severity: "warning",
          stack: "Error: command override\n    at extension.ts:1:1",
          timestamp: 100,
        },
        {
          errorName: "Error",
          extension: owner,
          message: "activation failed",
          phase: "activate",
          severity: "error",
          stack: "Error: activation failed\n    at extension.ts:1:1",
          timestamp: 200,
        },
        {
          errorName: "Error",
          extension: owner,
          message: "missing optional env",
          phase: "report",
          severity: "error",
          timestamp: 300,
        },
      ],
      errorCount: 2,
      warningCount: 1,
    });
  });
});
