import { setTimeout as delay } from "node:timers/promises";
import type { AppServerClient } from "@/app-server-client";
import { extractHttpStatus } from "@/telemetry/error-reporting";

export async function connectRemoteWorkerWithRetry(
  connect: () => Promise<AppServerClient>,
  signal?: AbortSignal,
): Promise<AppServerClient> {
  const backoffs = [1_000, 3_000];
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await connect();
    } catch (error) {
      signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      const status = extractHttpStatus(message);
      const transient =
        status !== undefined
          ? status >= 500
          : /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket closed|connection reset|timed out|closed before opening/i.test(
              message,
            );
      const backoff = backoffs[attempt];
      if (!transient || backoff === undefined) throw error;
      await delay(backoff, undefined, { signal });
    }
  }
}
