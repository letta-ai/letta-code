import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = fileURLToPath(new URL("../cli/app", import.meta.url));
const LEGACY_ORDER = [
  "useSubmitHandler.ts",
  "useConversationLoop.ts",
  "useConfigurationHandlers.ts",
  "useInterruptHandler.ts",
  "AppCoordinator.tsx",
  "AppView.tsx",
  "useReasoningCycle.ts",
  "useApprovalFlow.ts",
  "useConversationSwitching.ts",
  "useBashHandlers.ts",
  "useQueuedApprovalSubmit.ts",
  "useFeedbackHandler.ts",
  "submitDiagnosticsCommands.ts",
  "submitConnectionCommands.ts",
  "submitNavigationCommands.ts",
  "submitProfileCommands.ts",
];

function collectSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (entry.isFile() && /\.(tsx?|mts|cts)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

export function readInteractiveAppSource(): string {
  const sourceFiles = collectSourceFiles(APP_DIR).sort((a, b) =>
    a.localeCompare(b),
  );
  const sourceFileSet = new Set(sourceFiles);
  const orderedFiles: string[] = [];

  for (const fileName of LEGACY_ORDER) {
    const fullPath = join(APP_DIR, fileName);
    if (sourceFileSet.has(fullPath)) {
      orderedFiles.push(fullPath);
      sourceFileSet.delete(fullPath);
    }
  }

  orderedFiles.push(
    ...Array.from(sourceFileSet).sort((a, b) => a.localeCompare(b)),
  );

  return orderedFiles.map((path) => readFileSync(path, "utf-8")).join("\n");
}
