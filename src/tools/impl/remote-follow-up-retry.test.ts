import { expect, mock, test } from "bun:test";
import type { AppServerClient } from "@/app-server-client";
import type { SubagentMessageResponse } from "@/types/subagent-protocol";
import {
  RemoteFollowUpTimeoutError,
  sendRemoteFollowUpWithReconnect,
} from "./remote-follow-up-retry";

const command = {
  request_id: "follow-up-1",
  runtime: { agent_id: "parent", conversation_id: "conversation" },
  agent_id: "worker",
  message: "Continue",
};
const response = {
  type: "subagent_message_response",
  request_id: command.request_id,
  success: true,
  delivery: "steered",
} satisfies SubagentMessageResponse;

function setup(canResendOnTimeout = true) {
  let elapsed = 0;
  const timeout: AppServerClient["sendSubagentMessage"] = async (
    sent,
    options,
  ) => {
    elapsed += options?.timeoutMs ?? 0;
    throw new Error(`Timed out waiting for ${sent.request_id}`);
  };
  const send = mock(timeout);
  const close = mock(() => {});
  const client = {
    sendSubagentMessage: send,
    close,
  } as unknown as AppServerClient;
  const sendAfterReconnect = mock<AppServerClient["sendSubagentMessage"]>(
    async () => response,
  );
  const reconnected = {
    sendSubagentMessage: sendAfterReconnect,
  } as unknown as AppServerClient;
  const connect = mock(async () => {
    elapsed += 50;
    return reconnected;
  });
  const attach = mock((_client: AppServerClient) => {});
  return {
    send,
    timeout,
    close,
    connect,
    attach,
    reconnected,
    sendAfterReconnect,
    elapsed: () => elapsed,
    deliver: () =>
      sendRemoteFollowUpWithReconnect(
        client,
        command,
        connect,
        attach,
        "worker",
        {
          canResendOnTimeout,
          resendIntervalMs: 30,
          timeoutMs: 100,
          now: () => elapsed,
        },
      ),
  };
}

test("resends a silently lost follow-up on the same socket with the same command", async () => {
  const { deliver, send, timeout, connect, elapsed } = setup();
  send.mockImplementationOnce(timeout);
  send.mockResolvedValueOnce(response);

  expect(await deliver()).toEqual(response);
  expect(elapsed()).toBe(30);
  expect(send.mock.calls).toEqual([
    [command, { timeoutMs: 30 }],
    [command, { timeoutMs: 30 }],
  ]);
  expect(send.mock.calls[1]?.[0]).toBe(command);
  expect(connect).not.toHaveBeenCalled();
});

test("repeated lost follow-ups exhaust a single timeout budget", async () => {
  const { deliver, send, elapsed } = setup();

  await expect(deliver()).rejects.toBeInstanceOf(RemoteFollowUpTimeoutError);
  expect(elapsed()).toBe(100);
  expect(send.mock.calls.map(([, options]) => options?.timeoutMs)).toEqual([
    30, 30, 30, 10,
  ]);
});

test("without timeout resends, a lost follow-up gets one full-budget attempt", async () => {
  const { deliver, send, elapsed } = setup(false);

  await expect(deliver()).rejects.toBeInstanceOf(RemoteFollowUpTimeoutError);
  expect(elapsed()).toBe(100);
  expect(send.mock.calls).toEqual([[command, { timeoutMs: 100 }]]);
});

test("a socket close during a resend reconnects within the original budget", async () => {
  const {
    deliver,
    send,
    timeout,
    close,
    connect,
    attach,
    reconnected,
    sendAfterReconnect,
  } = setup();
  send.mockImplementationOnce(timeout);
  send.mockRejectedValueOnce(new Error("App-server socket closed"));

  expect(await deliver()).toEqual(response);
  expect(close).toHaveBeenCalledTimes(1);
  expect(connect).toHaveBeenCalledTimes(1);
  expect(attach).toHaveBeenCalledWith(reconnected);
  expect(sendAfterReconnect.mock.calls).toEqual([[command, { timeoutMs: 20 }]]);
});
