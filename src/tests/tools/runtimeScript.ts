import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createTempRuntimeScriptCommand(script: string): {
  command: string;
  cleanup: () => void;
} {
  const tempDir = mkdtempSync(join(tmpdir(), "letta-runtime-script-"));
  const scriptPath = join(tempDir, "script.js");
  writeFileSync(scriptPath, script, "utf8");

  return {
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}
