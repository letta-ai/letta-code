import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import {
  configureMcpOriginatorAuthorityPersistenceForTests,
  markMcpOriginatorTerminal,
  resetMcpOriginatorAuthority,
} from "@/agent/mcp-originator-authority";
import {
  clearMcpOriginatorTokens,
  getMcpOriginatorToken,
} from "@/agent/mcp-originator-tokens";
import { acknowledgeInputFrame } from "./input-ack";

function withDegradedFile(run: (path: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "letta-ack-authority-"));
  try {
    const path = join(root, "authority.json");
    writeFileSync(path, "{ not json !!!");
    configureMcpOriginatorAuthorityPersistenceForTests(path);
    resetMcpOriginatorAuthority();
    run(path);
  } finally {
    configureMcpOriginatorAuthorityPersistenceForTests(null);
    resetMcpOriginatorAuthority();
    rmSync(root, { recursive: true, force: true });
  }
}

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
  configureMcpOriginatorAuthorityPersistenceForTests(null);
  resetMcpOriginatorAuthority();
});

describe("acknowledgeInputFrame originator delivery gate", () => {
  test("a retryable denial (degraded durable store) suppresses the ack so Cloud redelivers (round-8 verdict split)", () => {
    withDegradedFile(() => {
      const { send, sent } = makeSend();
      acknowledgeInputFrame(
        send,
        SOCKET,
        {
          request_id: "req-1",
          runtime: undefined,
          super_run_id: "run-a",
          mcp_originator_token: "mst_a",
          mcp_originator_generation: 1,
        } as never,
        true,
        undefined,
        "started",
      );
      // Unacked: the admission could not be evaluated, so redelivery must
      // retry the whole admission once the store heals.
      expect(sent).toEqual([]);
      expect(getMcpOriginatorToken("run-a")).toBeUndefined();
    });
  });

  test("a permanently denied delivery is CONSUMED (acked) without the token — no redelivery loop (round-8 verdict split)", () => {
    // Malformed generation: this frame can never be admitted, so
    // suppressing the ack would redeliver the same bytes forever. The
    // listener consumes it with the normal ack and runs without the token.
    const { send, sent } = makeSend();
    acknowledgeInputFrame(
      send,
      SOCKET,
      {
        request_id: "req-1b",
        runtime: undefined,
        super_run_id: "run-a",
        mcp_originator_token: "mst_a",
        mcp_originator_generation: 1.5,
      } as never,
      true,
      undefined,
      "started",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({ accepted: true });
    expect(getMcpOriginatorToken("run-a")).toBeUndefined();
  });

  test("a delivery for a retired (terminal) run is consumed without the token (round-8 verdict split)", () => {
    markMcpOriginatorTerminal("run-a");
    const { send, sent } = makeSend();
    acknowledgeInputFrame(
      send,
      SOCKET,
      {
        request_id: "req-1c",
        runtime: undefined,
        super_run_id: "run-a",
        mcp_originator_token: "mst_a",
        mcp_originator_generation: 2,
      } as never,
      true,
      undefined,
      "started",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({ accepted: true });
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
    // The retryable deny path must not poison later admission: once the
    // durable store heals, Cloud's redelivery of the same frame succeeds.
    withDegradedFile((path) => {
      const first = makeSend();
      acknowledgeInputFrame(
        first.send,
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
      expect(first.sent).toEqual([]);

      // Operator restores a valid file: the next read heals.
      writeFileSync(path, JSON.stringify({ version: 1, records: {} }));
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
});
