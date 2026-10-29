import { readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile } from "./local-transcript";

/**
 * Read every agent record in `agentsDir` for LocalStore. A single unreadable
 * record (e.g. a 0-byte file left by an interrupted write) must not take down
 * the whole store, so it is moved aside to `<file>.corrupt` (still
 * recoverable) and a warning goes to stderr, since a backend spawned as a
 * child process may have no other visible log at this point.
 */
export function readAgentRecordFiles(
  agentsDir: string,
): Array<{ mtimeMs: number; raw: unknown }> {
  const records: Array<{ mtimeMs: number; raw: unknown }> = [];
  for (const file of readdirSync(agentsDir)) {
    if (!file.endsWith(".json") || file.startsWith("._")) continue;
    const filePath = join(agentsDir, file);
    try {
      const mtimeMs = statSync(filePath).mtimeMs;
      records.push({ mtimeMs, raw: readJsonFile<unknown>(filePath) });
    } catch (error) {
      quarantineUnreadableAgentRecord(filePath, error);
    }
  }
  return records;
}

function quarantineUnreadableAgentRecord(filePath: string, error: unknown) {
  const reason = error instanceof Error ? error.message : String(error);
  const quarantinePath = `${filePath}.corrupt`;
  try {
    renameSync(filePath, quarantinePath);
    console.warn(
      `[local-store] Skipped unreadable agent record ${filePath} (${reason}); moved it to ${quarantinePath}`,
    );
  } catch {
    console.warn(
      `[local-store] Skipped unreadable agent record ${filePath} (${reason})`,
    );
  }
}
