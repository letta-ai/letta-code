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
  if (/\b(EPIPE|EIO|EBADF)\b/.test(message)) {
    return false;
  }

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
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function installFatalErrorHandlers(
  options: FatalErrorHandlerOptions,
): () => void {
  let handlingFatalError = false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FATAL_DRAIN_TIMEOUT_MS;

  const handleFatalError = (
    errorType: FatalErrorType,
    error: unknown,
  ): void => {
    process.exitCode = 1;

    if (handlingFatalError) {
      return;
    }
    handlingFatalError = true;

    const message = getErrorMessage(error);
    if (shouldTrackFatalError(errorType, message)) {
      try {
        options.trackError(errorType, message, `process_${errorType}`);
      } catch {}
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
