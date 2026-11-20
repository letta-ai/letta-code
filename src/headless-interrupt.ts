import { randomUUID } from "node:crypto";
import { writeWireMessageAsync } from "@/stream-json-writer";
import { waitForForegroundBashCleanup } from "@/tools/impl/bash";

export async function exitInterruptedHeadless(
  interruptSignal: AbortSignal,
  outputFormat: string,
  sessionId: string,
  exitHeadless: (code: number, reason: string) => Promise<never>,
): Promise<never> {
  const term = interruptSignal.reason?.message === "SIGTERM";
  const message = term ? "Interrupted by SIGTERM" : "Interrupted by SIGINT";
  await waitForForegroundBashCleanup();
  if (outputFormat === "stream-json") {
    await writeWireMessageAsync({
      type: "error",
      message,
      stop_reason: "cancelled",
      session_id: sessionId,
      uuid: `error-interrupted-${randomUUID()}`,
    });
  } else {
    console.error(message);
  }
  return exitHeadless(
    term ? 143 : 130,
    term ? "headless_sigterm_interrupted" : "headless_sigint_interrupted",
  );
}
