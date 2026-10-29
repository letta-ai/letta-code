import { describe, expect, test } from "bun:test";
import { resolvePiRequestHeaders } from "./pi-request-headers";

describe("resolvePiRequestHeaders", () => {
  test("adds the conversation identity without dropping configured headers", () => {
    expect(
      resolvePiRequestHeaders({
        provider: "opencode-go",
        configuredHeaders: { "x-existing": "value" },
        conversationId: "conv-opencode-1",
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
      }),
    ).toBe(configuredHeaders);
  });
});
