import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  createExtensionDiagnosticsReport,
  type ExtensionDiagnosticsReport,
} from "@/extensions/extension-diagnostics";
import type { ExtensionDiagnostic } from "@/extensions/types";

export interface ExtensionDiagnosticsFile {
  generatedAt: number;
  report: ExtensionDiagnosticsReport;
}

export function getDefaultExtensionDiagnosticsRoot(
  homeDirectory = homedir(),
): string {
  return path.join(homeDirectory, ".letta", "extensions", "diagnostics");
}

export function getExtensionDiagnosticsLatestFilePath(
  rootDirectory = getDefaultExtensionDiagnosticsRoot(),
): string {
  return path.join(rootDirectory, "latest.json");
}

function createExtensionDiagnosticsFile(
  diagnostics: readonly ExtensionDiagnostic[],
  generatedAt = Date.now(),
): ExtensionDiagnosticsFile {
  return {
    generatedAt,
    report: createExtensionDiagnosticsReport(diagnostics),
  };
}

export function writeExtensionDiagnosticsLatestFile(
  diagnostics: readonly ExtensionDiagnostic[],
  options: { generatedAt?: number; rootDirectory?: string } = {},
): ExtensionDiagnosticsFile {
  const file = createExtensionDiagnosticsFile(diagnostics, options.generatedAt);
  const filePath = getExtensionDiagnosticsLatestFilePath(options.rootDirectory);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
  return file;
}
