import { writeSync } from "node:fs";
import { getErrorMessage } from "@/utils/error";

// Marker emitted on stderr by a headless subagent child whose stdout stream
// failed before the final result envelope could be written. The parent
// subagent manager matches on it to retry the spawn once instead of
// surfacing a truncated-output parse failure.
export const SUBAGENT_STDOUT_LOST_MARKER =
  "headless stdout stream failed before the final result was written";

export function isSubagentStdoutLostError(stderr: string): boolean {
  return stderr.includes(SUBAGENT_STDOUT_LOST_MARKER);
}

/**
 * Write the stdout-lost marker to stderr synchronously. Callers exit the
 * process right after reporting, so an async `console.error` could be
 * truncated the same way the stdout stream was — `writeSync` to fd 2
 * guarantees the marker is flushed before `process.exit` runs.
 */
export function reportSubagentStdoutLoss(detail?: unknown): void {
  const suffix = detail === undefined ? "" : ` (${getErrorMessage(detail)})`;
  try {
    writeSync(2, `${SUBAGENT_STDOUT_LOST_MARKER}${suffix}\n`);
  } catch {
    // stderr is gone too; there is nowhere left to report.
  }
}
