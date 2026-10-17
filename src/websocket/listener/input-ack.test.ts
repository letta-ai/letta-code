import { afterEach, describe, expect, test } from "bun:test";
import type WebSocket from "ws";
import { resetMcpOriginatorAuthority } from "@/agent/mcp-originator-authority";
import {
  clearMcpOriginatorTokens,
  getMcpOriginatorToken,
} from "@/agent/mcp-originator-tokens";
import { acknowledgeInputFrame } from "./input-ack";

type SentFrame = { payload: unknown; errorType: string; context: string };

function makeSend(): {
  send: (
    socket: WebSocket,
    payload: unknown,
    errorType: string,
    context: string,
  ) => boolean;
  sent: SentFrame[];
} {
  const sent: SentFrame[] = [];
  return {
    sent,
    send: (_socket, payload, errorType, context) => {
      sent.push({ payload, errorType, context });
      return true;
    },
  };
}

const SOCKET = {} as WebSocket;

afterEach(() => {
  clearMcpOriginatorTokens();
  resetMcpOriginatorAuthority();
});

describe("acknowledgeInputFrame originator delivery gate", () => {
  test("a denied durable admission suppresses the ack so Cloud redelivers (round-7; evil-shub round-6 P1)", () => {
    const { send, sent } = makeSend();
    acknowledgeInputFrame(
      send,
      SOCKET,
      {
        request_id: "req-1",
        runtime: undefined,
        super_run_id: "run-a",
        mcp_originator_token: "mst_a",
        // Malformed generation: the durable authority gate fails closed.
        mcp_originator_generation: 1.5,
      } as never,
      true,
      undefined,
      "started",
    );
    expect(sent).toEqual([]);
    // No token was installed either.
    expect(getMcpOriginatorToken("run-a")).toBeUndefined();
  });

  test("an admitted delivery acks accepted:true and installs the token", () => {
    const { send, sent } = makeSend();
    acknowledgeInputFrame(
      send,
      SOCKET,
      {
        request_id: "req-2",
        runtime: undefined,
        super_run_id: "run-a",
        mcp_originator_token: "mst_a",
        mcp_originator_generation: 1,
      } as never,
      true,
      undefined,
      "started",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({
      type: "input_accepted",
      request_id: "req-2",
      accepted: true,
      disposition: "started",
    });
  });

  test("a frame with no originator stamp acks normally", () => {
    const { send, sent } = makeSend();
    acknowledgeInputFrame(
      send,
      SOCKET,
      { request_id: "req-3", runtime: undefined } as never,
      true,
      undefined,
      "queued",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({ accepted: true });
  });

  test("a rejected input acks accepted:false without touching the store", () => {
    const { send, sent } = makeSend();
    acknowledgeInputFrame(
      send,
      SOCKET,
      {
        request_id: "req-4",
        runtime: undefined,
        super_run_id: "run-a",
        mcp_originator_token: "mst_a",
        mcp_originator_generation: 1,
      } as never,
      false,
      "over capacity",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({
      accepted: false,
      error: "over capacity",
    });
  });

  test("a redelivered well-formed frame after a suppressed ack admits and acks", () => {
    // The deny path must not poison later admission: Cloud's redelivery of
    // the corrected frame succeeds.
    const first = makeSend();
    acknowledgeInputFrame(
      first.send,
      SOCKET,
      {
        request_id: "req-5",
        runtime: undefined,
        super_run_id: "run-a",
        mcp_originator_token: "mst_a",
        mcp_originator_generation: Number.NaN,
      } as never,
      true,
      undefined,
      "started",
    );
    expect(first.sent).toEqual([]);

    const second = makeSend();
    acknowledgeInputFrame(
      second.send,
      SOCKET,
      {
        request_id: "req-5",
        runtime: undefined,
        super_run_id: "run-a",
        mcp_originator_token: "mst_a",
        mcp_originator_generation: 1,
      } as never,
      true,
      undefined,
      "started",
    );
    expect(second.sent).toHaveLength(1);
    expect(second.sent[0]?.payload).toMatchObject({ accepted: true });
  });
});
