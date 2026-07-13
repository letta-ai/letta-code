import { describe, expect, test } from "bun:test";
import { normalizeOAuthProviderName } from "./oauth-provider-name";

describe("normalizeOAuthProviderName", () => {
  test("preserves exact valid aliases after trimming", () => {
    expect(normalizeOAuthProviderName("  Claude.Work_2  ")).toBe(
      "Claude.Work_2",
    );
  });

  test("uses an explicit provider-specific default", () => {
    expect(normalizeOAuthProviderName(undefined, "anthropic")).toBe(
      "anthropic",
    );
  });

  test("rejects empty and unsafe aliases", () => {
    expect(() => normalizeOAuthProviderName(" ")).toThrow(
      "OAuth provider name cannot be empty.",
    );
    expect(() => normalizeOAuthProviderName("work/account")).toThrow(
      "OAuth provider name may only contain letters, numbers, dots, underscores, and hyphens.",
    );
  });
});
