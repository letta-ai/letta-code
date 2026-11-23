import { writeSync } from "node:fs";
import { getErrorMessage } from "@/utils/error";

export const SUBAGENT_STDOUT_LOST_MARKER =
  "headless stdout stream failed before the final result was written";

export function isSubagentStdoutLostError(stderr: string): boolean {
  return stderr.includes(SUBAGENT_STDOUT_LOST_MARKER);
}

export function reportSubagentStdoutLoss(detail?: unknown): void {
  const suffix = detail === undefined ? "" : ` (${getErrorMessage(detail)})`;
  try {
    writeSync(2, `${SUBAGENT_STDOUT_LOST_MARKER}${suffix}\n`);
  } catch {}
}
