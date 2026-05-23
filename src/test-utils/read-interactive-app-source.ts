import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = fileURLToPath(new URL("../cli/app", import.meta.url));
const LEGACY_ORDER = [
  "use-submit-handler.ts",
  "use-conversation-loop.ts",
  "use-configuration-handlers.ts",
  "use-interrupt-handler.ts",
  "AppCoordinator.tsx",
  "AppView.tsx",
  "use-reasoning-cycle.ts",
  "use-approval-flow.ts",
  "use-conversation-switching.ts",
  "use-bash-handlers.ts",
  "use-queued-approval-submit.ts",
  "use-feedback-handler.ts",
  "submit-diagnostics-commands.ts",
  "submit-connection-commands.ts",
  "submit-navigation-commands.ts",
  "submit-profile-commands.ts",
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
