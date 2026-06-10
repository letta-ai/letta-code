import { describe, expect, test } from "bun:test";
import {
  appendModDiagnostic,
  createModDiagnosticsReport,
  getModDiagnosticSeverity,
  getModErrorDiagnostics,
  MOD_DIAGNOSTICS_MAX_COUNT,
  MOD_DIAGNOSTICS_RESET_COUNT,
  type ModDiagnosticCollector,
  recordModDiagnostic,
} from "@/mods/mod-diagnostics";
import type { ModDiagnostic, ModOwner } from "@/mods/types";

function createOwner(): ModOwner {
  return {
    generation: 1,
    id: "global:/tmp/example.ts",
    path: "/tmp/example.ts",
    scope: "global",
  };
}

function createError(message: string): Error {
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at mod.ts:1:1`;
  return error;
}

describe("mod diagnostics", () => {
  test("classifies diagnostic phases for future surfacing", () => {
    expect(getModDiagnosticSeverity("command_override")).toBe("warning");
    expect(getModDiagnosticSeverity("report")).toBe("error");
    expect(getModDiagnosticSeverity("report", "warning")).toBe("warning");
    expect(getModDiagnosticSeverity("report", "error")).toBe("error");
    expect(getModDiagnosticSeverity("activate")).toBe("error");
    expect(getModDiagnosticSeverity("event")).toBe("error");
  });

  test("records diagnostics and derives error diagnostics", () => {
    const registry: ModDiagnosticCollector = {
      diagnostics: [],
    };
    const owner = createOwner();
    const seen: ModDiagnostic[] = [];

    const warning = recordModDiagnostic(
      registry,
      {
        capability: { id: "reload", kind: "command" },
        error: new Error("command override"),
        owner,
        phase: "command_override",
      },
      (diagnostic) => seen.push(diagnostic),
    );
    const error = recordModDiagnostic(registry, {
      error: new Error("activation failed"),
      owner,
      phase: "activate",
    });

    expect(registry.diagnostics).toEqual([warning, error]);
    expect(getModErrorDiagnostics(registry.diagnostics)).toEqual([error]);
    expect(seen).toEqual([warning]);
    expect(warning.timestamp).toEqual(expect.any(Number));
    expect(error.timestamp).toEqual(expect.any(Number));
  });

  test("caps diagnostics on append with hysteresis", () => {
    const registry: ModDiagnosticCollector = {
      diagnostics: [],
    };
    const owner = createOwner();

    for (let index = 0; index <= MOD_DIAGNOSTICS_MAX_COUNT; index += 1) {
      appendModDiagnostic(registry, {
        error: new Error(`diagnostic ${index}`),
        owner,
        phase: "event",
        timestamp: index,
      });
    }

    expect(registry.diagnostics).toHaveLength(MOD_DIAGNOSTICS_RESET_COUNT);
    expect(registry.diagnostics[0]?.error.message).toBe("diagnostic 151");
    expect(registry.diagnostics.at(-1)?.error.message).toBe("diagnostic 200");

    appendModDiagnostic(registry, {
      error: new Error("diagnostic 201"),
      owner,
      phase: "event",
      timestamp: 201,
    });

    expect(registry.diagnostics).toHaveLength(MOD_DIAGNOSTICS_RESET_COUNT + 1);
    expect(registry.diagnostics.at(-1)?.error.message).toBe("diagnostic 201");
  });

  test("creates compact agent reports from diagnostics", () => {
    const owner = createOwner();
    const warning: ModDiagnostic = {
      capability: { id: "reload", kind: "command" },
      error: createError("command override"),
      owner,
      phase: "command_override",
      timestamp: 100,
    };
    const error: ModDiagnostic = {
      error: createError("activation failed"),
      owner,
      phase: "activate",
      timestamp: 200,
    };
    const reportError = new Error("missing optional env");
    reportError.stack = undefined;
    const report: ModDiagnostic = {
      error: reportError,
      owner,
      phase: "report",
      timestamp: 300,
    };

    expect(createModDiagnosticsReport([warning, error, report])).toEqual({
      diagnostics: [
        {
          capability: { id: "reload", kind: "command" },
          errorName: "Error",
          mod: owner,
          message: "command override",
          phase: "command_override",
          severity: "warning",
          stack: "Error: command override\n    at mod.ts:1:1",
          timestamp: 100,
        },
        {
          errorName: "Error",
          mod: owner,
          message: "activation failed",
          phase: "activate",
          severity: "error",
          stack: "Error: activation failed\n    at mod.ts:1:1",
          timestamp: 200,
        },
        {
          errorName: "Error",
          mod: owner,
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
