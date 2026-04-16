import { describe, expect, test } from "bun:test";
import { buildLogoutSuccessMessage } from "../../cli/helpers/logoutMessage";

describe("buildLogoutSuccessMessage", () => {
  test("uses the standard success message when no env API key is set", () => {
    expect(buildLogoutSuccessMessage(false)).toBe(
      "✓ Logged out successfully. Run 'letta' to re-authenticate.",
    );
  });

  test("warns when LETTA_API_KEY remains set in the environment", () => {
    const message = buildLogoutSuccessMessage(true);

    expect(message).toContain("✓ Cleared saved Letta credentials.");
    expect(message).toContain("LETTA_API_KEY is still set");
    expect(message).toContain("/logout does not clear environment variables");
    expect(message).not.toContain("Run 'letta' to re-authenticate.");
  });
});
