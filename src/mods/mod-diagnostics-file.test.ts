import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getDefaultModDiagnosticsRoot,
  getModDiagnosticsLatestFilePath,
  writeModDiagnosticsLatestFile,
} from "@/mods/mod-diagnostics-file";
import type { ModDiagnostic, ModOwner } from "@/mods/types";

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "letta-mod-diagnostics-"));
}

function createOwner(): ModOwner {
  return {
    generation: 1,
    id: "global:/tmp/example.ts",
    path: "/tmp/example.ts",
    scope: "global",
  };
}

function createDiagnostic(): ModDiagnostic {
  const error = new Error("activation failed");
  error.stack = "Error: activation failed\n    at mod.ts:1:1";
  return {
    error,
    owner: createOwner(),
    phase: "activate",
    timestamp: 100,
  };
}

describe("mod diagnostics file", () => {
  test("resolves diagnostics under the mods directory", () => {
    expect(getDefaultModDiagnosticsRoot("/home/test")).toBe(
      path.join("/home/test", ".letta", "mods", "diagnostics"),
    );
    expect(getModDiagnosticsLatestFilePath("/tmp/root")).toBe(
      path.join("/tmp/root", "latest.json"),
    );
  });

  test("resolves diagnostics under legacy extensions directory for legacy-only users", () => {
    const root = createTempDir();
    try {
      const legacyDirectory = path.join(root, ".letta", "extensions");
      mkdirSync(legacyDirectory, { recursive: true });

      expect(getDefaultModDiagnosticsRoot(root)).toBe(
        path.join(legacyDirectory, "diagnostics"),
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("writes latest diagnostics files and overwrites stale results", () => {
    const rootDirectory = createTempDir();
    try {
      const options = {
        generatedAt: 200,
        rootDirectory,
      };

      const firstWritten = writeModDiagnosticsLatestFile(
        [createDiagnostic()],
        options,
      );
      const filePath = getModDiagnosticsLatestFilePath(rootDirectory);

      expect(firstWritten).toMatchObject({
        generatedAt: 200,
        report: {
          diagnostics: [
            {
              mod: createOwner(),
              message: "activation failed",
              phase: "activate",
              severity: "error",
            },
          ],
          errorCount: 1,
          warningCount: 0,
        },
      });
      expect(readFileSync(filePath, "utf-8")).toBe(
        `${JSON.stringify(firstWritten, null, 2)}\n`,
      );

      const emptyWritten = writeModDiagnosticsLatestFile([], options);

      expect(emptyWritten).toEqual({
        generatedAt: 200,
        report: { diagnostics: [], errorCount: 0, warningCount: 0 },
      });
      expect(readFileSync(filePath, "utf-8")).toBe(
        `${JSON.stringify(emptyWritten, null, 2)}\n`,
      );
    } finally {
      rmSync(rootDirectory, { force: true, recursive: true });
    }
  });

  test("writes structured migration hints to latest diagnostics", () => {
    const rootDirectory = createTempDir();
    try {
      const diagnostic = createDiagnostic();
      diagnostic.capability = { id: "letta.getContext", kind: "api" };
      diagnostic.error = new Error("letta.getContext is not a function");
      diagnostic.phase = "deprecated_api";
      diagnostic.severity = "warning";

      const written = writeModDiagnosticsLatestFile([diagnostic], {
        generatedAt: 300,
        rootDirectory,
      });

      expect(written.report.diagnostics[0]).toMatchObject({
        capability: { id: "letta.getContext", kind: "api" },
        hint: "letta.getContext has been removed. Activation has no dynamic invocation context. Move dynamic work into a command, tool, event, permission, status, or statusline callback that receives ctx, or use explicit/global state such as process.cwd() for activation-time background work.",
        message: "letta.getContext is not a function",
        phase: "deprecated_api",
        severity: "warning",
      });
      expect(written.report).toMatchObject({ errorCount: 0, warningCount: 1 });
      expect(
        JSON.parse(
          readFileSync(getModDiagnosticsLatestFilePath(rootDirectory), "utf-8"),
        ).report.diagnostics[0].hint,
      ).toBe(
        "letta.getContext has been removed. Activation has no dynamic invocation context. Move dynamic work into a command, tool, event, permission, status, or statusline callback that receives ctx, or use explicit/global state such as process.cwd() for activation-time background work.",
      );
    } finally {
      rmSync(rootDirectory, { force: true, recursive: true });
    }
  });
});
