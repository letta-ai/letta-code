import type { AppServerClient } from "@/app-server-client";
import { REMOTE_SUBAGENT_MESSAGE_TIMEOUT_MS } from "./claude-steer-timeouts";

export class RemoteFollowUpTimeoutError extends Error {}

export class RemoteFollowUpSocketClosedError extends Error {}

export async function sendRemoteFollowUpWithReconnect(
  client: AppServerClient,
  command: Parameters<AppServerClient["sendSubagentMessage"]>[0],
  connect: () => Promise<AppServerClient>,
  attach: (client: AppServerClient) => void,
  computer: string,
) {
  try {
    try {
      return await client.sendSubagentMessage(command, {
        timeoutMs: REMOTE_SUBAGENT_MESSAGE_TIMEOUT_MS,
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "App-server socket closed"
      )
        throw error;
      client.close();
      const reconnected = await connect();
      attach(reconnected);
      return await reconnected.sendSubagentMessage(command, {
        timeoutMs: REMOTE_SUBAGENT_MESSAGE_TIMEOUT_MS,
      });
    }
  } catch (error) {
    if (error instanceof Error && error.message === "App-server socket closed")
      throw new RemoteFollowUpSocketClosedError(
        `The connection to ${computer} dropped before it confirmed the follow-up, even after one retry. The message may not have been delivered; check the worker's output, or send it again.`,
      );
    if (
      error instanceof Error &&
      error.message === `Timed out waiting for ${command.request_id}`
    )
      throw new RemoteFollowUpTimeoutError(
        `${computer} didn't confirm the follow-up within ${Math.round(REMOTE_SUBAGENT_MESSAGE_TIMEOUT_MS / 1000)}s. The message may not have been delivered; check the worker's output, or send it again.`,
      );
    throw error;
  }
}
