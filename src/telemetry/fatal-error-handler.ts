import { getErrorMessage } from "@/utils/error";

type FatalErrorType = "uncaught_exception" | "unhandled_rejection";

interface FatalErrorHandlerOptions {
  drain: () => Promise<void>;
  trackError: (
    errorType: FatalErrorType,
    message: string,
    context: string,
  ) => void;
  timeoutMs?: number;
}

const DEFAULT_FATAL_DRAIN_TIMEOUT_MS = 3_000;

function shouldTrackFatalError(
  errorType: FatalErrorType,
  message: string,
): boolean {
  // Broken pipe/TTY failures are generally caused by a closed output stream
  // rather than an actionable application failure.
  if (/\b(EPIPE|EIO|EBADF)\b/.test(message)) {
    return false;
  }

  // Rate limits surfacing as unhandled rejections are expected under load.
  return !(
    errorType === "unhandled_rejection" &&
    /\b429\b/.test(message) &&
    /rate.?limit/i.test(message)
  );
}

async function drainWithTimeout(
  drain: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      Promise.resolve().then(drain),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    // Fatal telemetry is best-effort and must never delay termination.
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/**
 * Installs one-shot fatal handlers that preserve process-failure semantics
 * while giving telemetry a bounded opportunity to flush.
 */
export function installFatalErrorHandlers(
  options: FatalErrorHandlerOptions,
): () => void {
  let handlingFatalError = false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FATAL_DRAIN_TIMEOUT_MS;

  const handleFatalError = (
    errorType: FatalErrorType,
    error: unknown,
  ): void => {
    // Set this synchronously so another listener or an early event-loop exit
    // cannot turn the fatal failure into a successful process result.
    process.exitCode = 1;

    if (handlingFatalError) {
      return;
    }
    handlingFatalError = true;

    const message = getErrorMessage(error);
    if (shouldTrackFatalError(errorType, message)) {
      try {
        options.trackError(errorType, message, `process_${errorType}`);
      } catch {
        // Tracking must not interfere with the fatal path.
      }
    }

    void drainWithTimeout(options.drain, timeoutMs).finally(() => {
      process.exit(1);
    });
  };

  const uncaughtExceptionHandler = (error: unknown): void => {
    handleFatalError("uncaught_exception", error);
  };
  const unhandledRejectionHandler = (reason: unknown): void => {
    handleFatalError("unhandled_rejection", reason);
  };

  process.on("uncaughtException", uncaughtExceptionHandler);
  process.on("unhandledRejection", unhandledRejectionHandler);

  return () => {
    process.off("uncaughtException", uncaughtExceptionHandler);
    process.off("unhandledRejection", unhandledRejectionHandler);
  };
}
