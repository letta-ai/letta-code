import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getDefaultExtensionDiagnosticsRoot,
  getExtensionDiagnosticsLatestFilePath,
  writeExtensionDiagnosticsLatestFile,
} from "@/extensions/extension-diagnostics-file";
import type { ExtensionDiagnostic, ExtensionOwner } from "@/extensions/types";

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "letta-extension-diagnostics-"));
}

function createOwner(): ExtensionOwner {
  return {
    generation: 1,
    id: "global:/tmp/example.ts",
    path: "/tmp/example.ts",
    scope: "global",
  };
}

function createDiagnostic(): ExtensionDiagnostic {
  const error = new Error("activation failed");
  error.stack = "Error: activation failed\n    at extension.ts:1:1";
  return {
    error,
    owner: createOwner(),
    phase: "activate",
    timestamp: 100,
  };
}

describe("extension diagnostics file", () => {
  test("resolves diagnostics under the extensions directory", () => {
    expect(getDefaultExtensionDiagnosticsRoot("/home/test")).toBe(
      path.join("/home/test", ".letta", "extensions", "diagnostics"),
    );
    expect(getExtensionDiagnosticsLatestFilePath("/tmp/root")).toBe(
      path.join("/tmp/root", "latest.json"),
    );
  });

  test("writes latest diagnostics files and overwrites stale results", () => {
    const rootDirectory = createTempDir();
    try {
      const options = {
        generatedAt: 200,
        rootDirectory,
      };

      const firstWritten = writeExtensionDiagnosticsLatestFile(
        [createDiagnostic()],
        options,
      );
      const filePath = getExtensionDiagnosticsLatestFilePath(rootDirectory);

      expect(firstWritten).toMatchObject({
        generatedAt: 200,
        report: {
          diagnostics: [
            {
              extension: createOwner(),
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

      const emptyWritten = writeExtensionDiagnosticsLatestFile([], options);

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
});
