import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  createExtensionDiagnosticsAgentReport,
  type ExtensionDiagnosticsAgentReport,
  type ExtensionDiagnosticsAgentReportOptions,
  formatExtensionDiagnosticsForAgent,
} from "@/extensions/extension-diagnostics";
import type { ExtensionDiagnostic } from "@/extensions/types";

export const EXTENSION_DIAGNOSTICS_FILE_VERSION = 1;

export interface ExtensionDiagnosticsFileOptions {
  rootDirectory?: string;
  sessionId: string;
}

export interface ExtensionDiagnosticsFile {
  generatedAt: number;
  report: ExtensionDiagnosticsAgentReport;
  sessionId: string;
  text: string;
  version: typeof EXTENSION_DIAGNOSTICS_FILE_VERSION;
}

export interface WriteExtensionDiagnosticsFileOptions
  extends ExtensionDiagnosticsFileOptions,
    ExtensionDiagnosticsAgentReportOptions {
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
    report: createExtensionDiagnosticsAgentReport(diagnostics, options),
    sessionId: options.sessionId,
    text: formatExtensionDiagnosticsForAgent(diagnostics, options),
    version: EXTENSION_DIAGNOSTICS_FILE_VERSION,
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

function isExtensionDiagnosticsFile(
  value: unknown,
): value is ExtensionDiagnosticsFile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ExtensionDiagnosticsFile>;
  return (
    candidate.version === EXTENSION_DIAGNOSTICS_FILE_VERSION &&
    typeof candidate.generatedAt === "number" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.text === "string" &&
    typeof candidate.report === "object" &&
    candidate.report !== null &&
    typeof candidate.report.errorCount === "number" &&
    typeof candidate.report.warningCount === "number" &&
    Array.isArray(candidate.report.diagnostics)
  );
}

export function readExtensionDiagnosticsLatestFile(
  options: ExtensionDiagnosticsFileOptions,
): ExtensionDiagnosticsFile | null {
  const filePath = getExtensionDiagnosticsLatestFilePath(options);
  if (!existsSync(filePath)) return null;

  const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
  if (!isExtensionDiagnosticsFile(parsed)) {
    throw new Error(`Invalid extension diagnostics file at ${filePath}`);
  }

  return parsed;
}
