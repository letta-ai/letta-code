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
    ).toEqual({ "x-opencode-session": "conv-opencode-1" });
  });

  test("leaves another provider's headers unchanged", () => {
    const configuredHeaders = { "x-existing": "value" };
    expect(
      resolvePiRequestHeaders({
        provider: "openai",
        configuredHeaders,
        conversationId: "conv-openai-1",
        requestKind: "turn",
      }),
    ).toBe(configuredHeaders);
  });

  test("tells a self-hosted endpoint whether a request is a turn or a compaction", () => {
    for (const provider of [
      "llama-cpp",
      "lmstudio",
      "ollama",
      "openai-compatible",
    ]) {
      for (const requestKind of ["turn", "compaction"] as const) {
        expect(
          resolvePiRequestHeaders({
            provider,
            configuredHeaders: { "x-existing": "value" },
            conversationId: "conv-local-1",
            requestKind,
          }),
        ).toEqual({
          "x-existing": "value",
          "x-letta-request-kind": requestKind,
        });
      }
    }
  });

  test("does not send the request kind to hosted providers", () => {
    for (const provider of ["openai", "anthropic", "ollama-cloud"]) {
      expect(
        resolvePiRequestHeaders({
          provider,
          configuredHeaders: undefined,
          conversationId: "conv-hosted-1",
          requestKind: "compaction",
        }),
      ).toBeUndefined();
    }
  });
});
