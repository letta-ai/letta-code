import type { ResumeQueueCommand } from "@/types/queue-update-protocol";
import { isRuntimeScope } from "./protocol-validation";

/** Wire validator for `resume_queue` (release interrupt-parked queue items). */
export function isResumeQueueCommand(
  value: unknown,
): value is ResumeQueueCommand {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    type?: unknown;
    runtime?: unknown;
    request_id?: unknown;
  };
  return (
    candidate.type === "resume_queue" &&
    isRuntimeScope(candidate.runtime) &&
    (candidate.request_id === undefined ||
      typeof candidate.request_id === "string")
  );
}
