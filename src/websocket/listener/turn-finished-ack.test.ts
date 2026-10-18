import { expect, mock, test } from "bun:test";
import { createRuntime } from "./lifecycle";
import { handleTurnFinishedAck } from "./turn-finished-ack";

test("a terminal ACK promotes deferred capacity and immediately replays it", () => {
  const listener = createRuntime();
  const promote = mock(() => 1);
  listener.promotePreparedInputTerminals = promote;
  const acknowledge = mock(() => true);
  const replay = mock(() => {});

  handleTurnFinishedAck(
    listener,
    {} as never,
    "conn-owner",
    {
      runtime: { agent_id: null, conversation_id: "conversation-1" },
      idempotency_key: "turn_finished:old",
      consumer_id: "slack:agent-1",
    },
    { acknowledge: acknowledge as never, replay: replay as never },
  );

  expect(acknowledge).toHaveBeenCalledTimes(1);
  expect(promote).toHaveBeenCalledTimes(1);
  expect(replay).toHaveBeenCalledTimes(1);
  expect((replay.mock.calls as unknown[][])[0]?.[2]).toBe("conn-owner");
});

test("a rejected or duplicate ACK cannot promote another terminal", () => {
  const listener = createRuntime();
  const promote = mock(() => 1);
  listener.promotePreparedInputTerminals = promote;

  handleTurnFinishedAck(
    listener,
    {} as never,
    "conn-owner",
    {
      runtime: { agent_id: "agent-1", conversation_id: "conversation-1" },
      idempotency_key: "turn_finished:foreign",
      consumer_id: "slack:agent-1",
    },
    { acknowledge: (() => false) as never },
  );

  expect(promote).toHaveBeenCalledTimes(0);
});
