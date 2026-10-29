import { describe, expect, test } from "bun:test";
import { resolvePiRequestHeaders } from "./pi-request-headers";

describe("resolvePiRequestHeaders", () => {
  test("adds the conversation identity without dropping configured headers", () => {
    expect(
      resolvePiRequestHeaders({
        provider: "opencode-go",
        configuredHeaders: { "x-existing": "value" },
        conversationId: "conv-opencode-1",
        requestKind: "turn",
      }),
    ).toEqual({
      "x-existing": "value",
      "x-letta-request-kind": "turn",
      "x-opencode-session": "conv-opencode-1",
    });
  });

  test("uses the trusted conversation identity over a configured value", () => {
    expect(
      resolvePiRequestHeaders({
        provider: "opencode-go",
        configuredHeaders: { "x-opencode-session": "stale" },
        conversationId: "conv-opencode-1",
        requestKind: "turn",
      }),
    ).toEqual({
      "x-letta-request-kind": "turn",
      "x-opencode-session": "conv-opencode-1",
    });
  });

  test("tells every provider whether a request is a turn or a compaction", () => {
    for (const provider of ["llama-cpp", "openai", "anthropic"]) {
      for (const requestKind of ["turn", "compaction"] as const) {
        expect(
          resolvePiRequestHeaders({
            provider,
            configuredHeaders: { "x-existing": "value" },
            conversationId: "conv-1",
            requestKind,
          }),
        ).toEqual({
          "x-existing": "value",
          "x-letta-request-kind": requestKind,
        });
      }
    }
  });

  test("uses the request kind over a configured value", () => {
    expect(
      resolvePiRequestHeaders({
        provider: "llama-cpp",
        configuredHeaders: { "x-letta-request-kind": "turn" },
        conversationId: "conv-1",
        requestKind: "compaction",
      }),
    ).toEqual({ "x-letta-request-kind": "compaction" });
  });
});
