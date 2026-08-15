import { describe, expect, test } from "bun:test";
import { parseServerMessage } from "@/websocket/listener/protocol-inbound";

describe("client toolset protocol", () => {
  test("parses request-scoped toolset configuration", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          payload: {
            kind: "create_message",
            messages: [{ role: "user", content: "hello" }],
            client_toolset: {
              base: "none",
              include: ["Read", "LS", "Glob", "Grep"],
            },
            client_tool_allowlist: ["Read", "LS", "Glob", "Grep"],
          },
        }),
      ),
    );

    expect(parsed).toMatchObject({
      type: "input",
      payload: {
        kind: "create_message",
        client_toolset: {
          base: "none",
          include: ["Read", "LS", "Glob", "Grep"],
        },
      },
    });
  });

  test("rejects invalid request-scoped toolset configuration", () => {
    const parsed = parseServerMessage(
      Buffer.from(
        JSON.stringify({
          type: "input",
          runtime: { agent_id: "agent-1", conversation_id: "default" },
          payload: {
            kind: "create_message",
            messages: [{ role: "user", content: "hello" }],
            client_toolset: {
              base: "invented",
              include: ["Read"],
            },
          },
        }),
      ),
    );

    expect(parsed).toEqual({
      type: "__invalid_input",
      runtime: { agent_id: "agent-1", conversation_id: "default" },
      reason:
        "Protocol violation: input.payload.client_toolset must contain an optional valid base and string[] include",
    });
  });
});
