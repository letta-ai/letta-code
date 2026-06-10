import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  createModDiagnosticsReport,
  type ModDiagnosticsReport,
} from "@/mods/mod-diagnostics";
import { resolveDefaultGlobalModsDirectory } from "@/mods/paths";
import type { ModDiagnostic } from "@/mods/types";

export interface ModDiagnosticsFile {
  generatedAt: number;
  report: ModDiagnosticsReport;
}

export function getDefaultModDiagnosticsRoot(
  homeDirectory = homedir(),
): string {
  return path.join(
    resolveDefaultGlobalModsDirectory(homeDirectory),
    "diagnostics",
  );
}

export function getModDiagnosticsLatestFilePath(
  rootDirectory = getDefaultModDiagnosticsRoot(),
): string {
  return path.join(rootDirectory, "latest.json");
}

function createModDiagnosticsFile(
  diagnostics: readonly ModDiagnostic[],
  generatedAt = Date.now(),
): ModDiagnosticsFile {
  return {
    generatedAt,
    report: createModDiagnosticsReport(diagnostics),
  };
}

export function writeModDiagnosticsLatestFile(
  diagnostics: readonly ModDiagnostic[],
  options: { generatedAt?: number; rootDirectory?: string } = {},
): ModDiagnosticsFile {
  const file = createModDiagnosticsFile(diagnostics, options.generatedAt);
  const filePath = getModDiagnosticsLatestFilePath(options.rootDirectory);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
  return file;
}
