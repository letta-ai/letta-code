import { describe, expect, test } from "bun:test";
import {
  appendModDiagnostic,
  createModDiagnosticsReport,
  getModDiagnosticSeverity,
  getModErrorDiagnostics,
  MOD_DIAGNOSTICS_MAX_COUNT,
  MOD_DIAGNOSTICS_RESET_COUNT,
  MOD_PANEL_CONTEXT_MIGRATION_HINT,
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
    expect(getModDiagnosticSeverity("deprecated_api")).toBe("warning");
    expect(getModDiagnosticSeverity("deprecated_api", "error")).toBe("error");
    expect(getModDiagnosticSeverity("legacy_extension")).toBe("warning");
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

  test("adds panel context migration hints for old statusline fields", () => {
    const owner = createOwner();
    const report = createModDiagnosticsReport([
      {
        capability: { id: "spotify-statusline", kind: "panel" },
        error: createError(
          "Cannot destructure property 'Box' of 'context.components' as it is undefined.",
        ),
        owner,
        phase: "panel.render",
        timestamp: 100,
      },
    ]);

    expect(report.diagnostics[0]?.hint).toBe(MOD_PANEL_CONTEXT_MIGRATION_HINT);
  });

  test("adds structured migration hints for removed getContext APIs", () => {
    const owner = createOwner();
    const report = createModDiagnosticsReport([
      {
        capability: { id: "legacy", kind: "tool" },
        error: createError("ctx.getContext is not a function"),
        owner,
        phase: "tool.isEnabled",
        timestamp: 400,
      },
    ]);

    expect(report.diagnostics[0]).toMatchObject({
      capability: { id: "legacy", kind: "tool" },
      hint: "Dynamic context is now passed as ctx to commands, tools, events, permissions, and UI renderers. Use ctx.agent, ctx.cwd, ctx.conversation, ctx.model, etc.",
      message: "ctx.getContext is not a function",
      phase: "tool.isEnabled",
    });
  });

  test("adds structured migration hints for deprecated API diagnostics", () => {
    const owner = createOwner();
    const report = createModDiagnosticsReport([
      {
        capability: { id: "letta.getContext", kind: "api" },
        error: createError("Mod source uses removed API: letta.getContext"),
        owner,
        phase: "deprecated_api",
        severity: "warning",
        timestamp: 500,
      },
    ]);

    expect(report).toMatchObject({
      diagnostics: [
        {
          capability: { id: "letta.getContext", kind: "api" },
          hint: "letta.getContext has been removed. Activation has no dynamic invocation context. Move dynamic work into a command, tool, event, permission, status, or statusline callback that receives ctx, or use explicit/global state such as process.cwd() for activation-time background work.",
          phase: "deprecated_api",
          severity: "warning",
        },
      ],
      errorCount: 0,
      warningCount: 1,
    });
  });
});
