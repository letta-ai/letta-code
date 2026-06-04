import { describe, expect, test } from "bun:test";
import {
  createExtensionDiagnosticsAgentReport,
  type ExtensionDiagnosticCollector,
  formatExtensionDiagnosticsForAgent,
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

    expect(createExtensionDiagnosticsAgentReport([warning, error])).toEqual({
      diagnostics: [
        {
          capability: { id: "reload", kind: "command" },
          errorName: "Error",
          extension: owner,
          message: "command override",
          phase: "command_override",
          severity: "warning",
          source: "host",
          timestamp: 100,
        },
        {
          errorName: "Error",
          extension: owner,
          message: "activation failed",
          phase: "activate",
          severity: "error",
          source: "host",
          timestamp: 200,
        },
      ],
      errorCount: 1,
      warningCount: 1,
    });
  });

  test("includes stacks in agent reports only when requested", () => {
    const diagnostic: ExtensionDiagnostic = {
      error: createError("activation failed"),
      owner: createOwner(),
      phase: "activate",
      timestamp: 100,
    };

    expect(
      createExtensionDiagnosticsAgentReport([diagnostic]).diagnostics[0],
    ).not.toHaveProperty("stack");
    expect(
      createExtensionDiagnosticsAgentReport([diagnostic], {
        includeStack: true,
      }).diagnostics[0],
    ).toMatchObject({
      stack: "Error: activation failed\n    at extension.ts:1:1",
    });
  });

  test("formats diagnostics for agent context", () => {
    const owner = createOwner();
    const warning: ExtensionDiagnostic = {
      capability: { id: "reload", kind: "command" },
      error: createError("command override"),
      owner,
      phase: "command_override",
      timestamp: 100,
    };
    const error: ExtensionDiagnostic = {
      error: createError("activation failed\ncheck default export"),
      owner,
      phase: "activate",
      timestamp: 200,
    };

    expect(formatExtensionDiagnosticsForAgent([])).toBe(
      "No extension diagnostics recorded.",
    );
    expect(formatExtensionDiagnosticsForAgent([warning, error])).toBe(
      `Extension diagnostics: 1 error, 1 warning
- [warning] command_override command:reload /tmp/example.ts
  message: command override
- [error] activate /tmp/example.ts
  message: activation failed check default export`,
    );
  });

  test("formats stacks for agent context when requested", () => {
    const diagnostic: ExtensionDiagnostic = {
      error: createError("activation failed"),
      owner: createOwner(),
      phase: "activate",
      timestamp: 100,
    };

    expect(
      formatExtensionDiagnosticsForAgent([diagnostic], { includeStack: true }),
    ).toBe(`Extension diagnostics: 1 error, 0 warnings
- [error] activate /tmp/example.ts
  message: activation failed
  stack:
    Error: activation failed
        at extension.ts:1:1`);
  });
});
