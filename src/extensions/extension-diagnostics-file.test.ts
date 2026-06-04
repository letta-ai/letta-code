import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createExtensionDiagnosticsFile,
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
    expect(
      getExtensionDiagnosticsLatestFilePath({
        rootDirectory: "/tmp/root",
        sessionId: "../conv/with/slash",
      }),
    ).toBe(
      path.join(
        "/tmp/root",
        "sessions",
        "%2E%2E%2Fconv%2Fwith%2Fslash",
        "latest.json",
      ),
    );
  });

  test("rejects empty diagnostics session ids", () => {
    expect(() =>
      getExtensionDiagnosticsLatestFilePath({
        rootDirectory: "/tmp/root",
        sessionId: "",
      }),
    ).toThrow("Extension diagnostics session id must not be empty");
  });

  test("creates a latest diagnostics file payload", () => {
    expect(
      createExtensionDiagnosticsFile([createDiagnostic()], {
        generatedAt: 200,
        sessionId: "conv-1",
      }),
    ).toMatchObject({
      generatedAt: 200,
      report: {
        diagnostics: [
          {
            extension: createOwner(),
            message: "activation failed",
            phase: "activate",
            severity: "error",
            source: "host",
          },
        ],
        errorCount: 1,
        warningCount: 0,
      },
      sessionId: "conv-1",
      text: `Extension diagnostics: 1 error, 0 warnings
- [error] activate /tmp/example.ts
  message: activation failed`,
    });
  });

  test("writes latest diagnostics files", () => {
    const rootDirectory = createTempDir();
    try {
      const options = {
        generatedAt: 200,
        rootDirectory,
        sessionId: "conv-1",
      };

      const written = writeExtensionDiagnosticsLatestFile(
        [createDiagnostic()],
        options,
      );
      const filePath = getExtensionDiagnosticsLatestFilePath(options);

      expect(readFileSync(filePath, "utf-8")).toBe(
        `${JSON.stringify(written, null, 2)}\n`,
      );
    } finally {
      rmSync(rootDirectory, { force: true, recursive: true });
    }
  });

  test("writes empty latest diagnostics files to avoid stale results", () => {
    const rootDirectory = createTempDir();
    try {
      const options = {
        generatedAt: 200,
        rootDirectory,
        sessionId: "conv-1",
      };

      const written = writeExtensionDiagnosticsLatestFile([], options);

      expect(written).toEqual({
        generatedAt: 200,
        report: { diagnostics: [], errorCount: 0, warningCount: 0 },
        sessionId: "conv-1",
        text: "No extension diagnostics recorded.",
      });
    } finally {
      rmSync(rootDirectory, { force: true, recursive: true });
    }
  });
});
