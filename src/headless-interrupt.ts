import { randomUUID } from "node:crypto";
import { writeWireMessageAsync } from "@/stream-json-writer";
import { waitForForegroundBashCleanup } from "@/tools/impl/bash";
import { createProcessAbortSignal } from "@/utils/sigint-abort";

type ExitHeadless = (code: number, reason: string) => Promise<never>;

export function createHeadlessInterrupt(
  outputFormat: string,
  sessionId: string,
  exitHeadless: ExitHeadless,
) {
  const { signal, dispose } = createProcessAbortSignal(["SIGINT", "SIGTERM"]);
  let shutdown: Promise<never> | undefined;
  function exitInterrupted() {
    shutdown ??= exitInterruptedHeadless(
      signal,
      outputFormat,
      sessionId,
      exitHeadless,
    );
    return shutdown;
  }

  signal.addEventListener(
    "abort",
    () => {
      if (signal.reason?.message === "SIGTERM") void exitInterrupted();
    },
    { once: true },
  );
  return { signal, dispose, exitInterrupted };
}

async function exitInterruptedHeadless(
  interruptSignal: AbortSignal,
  outputFormat: string,
  sessionId: string,
  exitHeadless: ExitHeadless,
): Promise<never> {
  const term = interruptSignal.reason?.message === "SIGTERM";
  const message = term ? "Interrupted by SIGTERM" : "Interrupted by SIGINT";
  await waitForForegroundBashCleanup();
  if (outputFormat === "stream-json") {
    const write = writeWireMessageAsync({
      type: "error",
      message,
      stop_reason: "cancelled",
      session_id: sessionId,
      uuid: `error-interrupted-${randomUUID()}`,
    });
    if (term) await waitForTerminationOutput(write.catch(() => false));
    else await write;
  } else {
    console.error(message);
  }
  return exitHeadless(
    term ? 143 : 130,
    term ? "headless_sigterm_interrupted" : "headless_sigint_interrupted",
  );
}

export async function waitForTerminationOutput(
  write: Promise<unknown>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      write,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 250);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
