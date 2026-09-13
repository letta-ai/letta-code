import { describe, expect, test } from "bun:test";
import {
  normalizeSignalBaseUrl,
  parseSignalTarget,
  signalAllowedUsersIncludes,
  signalTargetToReactionRpcParams,
  signalTargetToSendRpcParams,
} from "./target";

describe("Signal target helpers", () => {
  test("normalizes and validates base URLs", () => {
    expect(normalizeSignalBaseUrl("127.0.0.1:8080/ ")).toBe(
      "http://127.0.0.1:8080",
    );
    expect(normalizeSignalBaseUrl("https://signal.example.test/api///")).toBe(
      "https://signal.example.test/api",
    );
    expect(() => normalizeSignalBaseUrl("ftp://127.0.0.1:8080")).toThrow(
      "Signal base URL protocol must be http or https",
    );
    expect(() =>
      normalizeSignalBaseUrl("http://user:pass@127.0.0.1:8080"),
    ).toThrow("Signal base URL must not include credentials.");
  });

  test("parses optional signal prefixes before target kind", () => {
    expect(parseSignalTarget("signal:group:abc123")).toEqual({
      kind: "group",
      groupId: "abc123",
    });
    expect(parseSignalTarget("signal:username:alice")).toEqual({
      kind: "username",
      username: "alice",
    });
    expect(parseSignalTarget("signal:+15555550123")).toEqual({
      kind: "recipient",
      recipient: "+15555550123",
    });
  });

  test("uses signal-cli send and reaction parameter names", () => {
    expect(
      signalTargetToSendRpcParams({ kind: "group", groupId: "g1" }),
    ).toEqual({
      groupId: "g1",
    });
    expect(
      signalTargetToReactionRpcParams({ kind: "group", groupId: "g1" }),
    ).toEqual({
      groupIds: ["g1"],
    });
    expect(
      signalTargetToReactionRpcParams({
        kind: "recipient",
        recipient: "+15555550123",
      }),
    ).toEqual({ recipients: ["+15555550123"] });
  });

  test("matches allowed users by Signal prefix or phone digits", () => {
    expect(
      signalAllowedUsersIncludes(["+1 (555) 555-0123"], "signal:+15555550123"),
    ).toBe(true);
    expect(signalAllowedUsersIncludes(["uuid-1"], "uuid-1")).toBe(true);
    expect(signalAllowedUsersIncludes(["uuid-1"], "uuid-2")).toBe(false);
  });
});
