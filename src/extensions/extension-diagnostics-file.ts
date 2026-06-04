import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  createExtensionDiagnosticsReport,
  type ExtensionDiagnosticsReport,
  type ExtensionDiagnosticsReportOptions,
  formatExtensionDiagnosticsForAgent,
} from "@/extensions/extension-diagnostics";
import type { ExtensionDiagnostic } from "@/extensions/types";

export interface ExtensionDiagnosticsFileOptions {
  rootDirectory?: string;
  sessionId: string;
}

export interface ExtensionDiagnosticsFile {
  generatedAt: number;
  report: ExtensionDiagnosticsReport;
  sessionId: string;
  text: string;
}

export interface WriteExtensionDiagnosticsFileOptions
  extends ExtensionDiagnosticsFileOptions,
    ExtensionDiagnosticsReportOptions {
  generatedAt?: number;
}

export function getDefaultExtensionDiagnosticsRoot(
  homeDirectory = homedir(),
): string {
  return path.join(homeDirectory, ".letta", "extensions", "diagnostics");
}

function encodeExtensionDiagnosticsPathSegment(segment: string): string {
  if (!segment.trim()) {
    throw new Error("Extension diagnostics session id must not be empty");
  }
  return encodeURIComponent(segment).replace(/\./g, "%2E");
}

export function getExtensionDiagnosticsLatestFilePath(
  options: ExtensionDiagnosticsFileOptions,
): string {
  const rootDirectory =
    options.rootDirectory ?? getDefaultExtensionDiagnosticsRoot();
  return path.join(
    rootDirectory,
    "sessions",
    encodeExtensionDiagnosticsPathSegment(options.sessionId),
    "latest.json",
  );
}

export function createExtensionDiagnosticsFile(
  diagnostics: readonly ExtensionDiagnostic[],
  options: WriteExtensionDiagnosticsFileOptions,
): ExtensionDiagnosticsFile {
  return {
    generatedAt: options.generatedAt ?? Date.now(),
    report: createExtensionDiagnosticsReport(diagnostics, options),
    sessionId: options.sessionId,
    text: formatExtensionDiagnosticsForAgent(diagnostics, options),
  };
}

export function writeExtensionDiagnosticsLatestFile(
  diagnostics: readonly ExtensionDiagnostic[],
  options: WriteExtensionDiagnosticsFileOptions,
): ExtensionDiagnosticsFile {
  const file = createExtensionDiagnosticsFile(diagnostics, options);
  const filePath = getExtensionDiagnosticsLatestFilePath(options);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
  return file;
}
