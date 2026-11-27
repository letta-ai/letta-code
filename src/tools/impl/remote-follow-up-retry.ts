import type { AppServerClient } from "@/app-server-client";
import { REMOTE_SUBAGENT_MESSAGE_TIMEOUT_MS } from "./claude-steer-timeouts";

export class RemoteFollowUpTimeoutError extends Error {}

export class RemoteFollowUpSocketClosedError extends Error {}

export async function sendRemoteFollowUpWithReconnect(
  client: AppServerClient,
  command: Parameters<AppServerClient["sendSubagentMessage"]>[0] & {
    request_id: string;
  },
  connect: () => Promise<AppServerClient>,
  attach: (client: AppServerClient) => void,
  computer: string,
  {
    canResendOnTimeout = false,
    resendIntervalMs = 30_000,
    timeoutMs = REMOTE_SUBAGENT_MESSAGE_TIMEOUT_MS,
    now = Date.now,
  } = {},
) {
  const deadline = now() + timeoutMs;
  const timeoutError = () =>
    new RemoteFollowUpTimeoutError(
      `${computer} didn't confirm the follow-up within ${Math.round(timeoutMs / 1000)}s. The message may not have been delivered; check the worker's output, or send it again.`,
    );
  let reconnected = false;
  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) throw timeoutError();
    const attemptTimeout = canResendOnTimeout
      ? Math.min(remaining, resendIntervalMs)
      : remaining;
    try {
      return await client.sendSubagentMessage(command, {
        timeoutMs: attemptTimeout,
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (error.message === `Timed out waiting for ${command.request_id}`) {
        if (attemptTimeout === remaining) throw timeoutError();
        continue;
      }
      if (error.message !== "App-server socket closed") throw error;
      if (reconnected)
        throw new RemoteFollowUpSocketClosedError(
          `The connection to ${computer} dropped before it confirmed the follow-up, even after one retry. The message may not have been delivered; check the worker's output, or send it again.`,
        );
      reconnected = true;
      client.close();
      const reconnectBudget = deadline - now();
      if (reconnectBudget <= 0) throw timeoutError();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        client = await Promise.race([
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(timeoutError()), reconnectBudget);
          }),
          connect().then((connected) => {
            if (now() < deadline) return connected;
            connected.close();
            throw timeoutError();
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      attach(client);
    }
  }
}
