import { describe, expect, test } from "bun:test";
import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import { shouldAddBaseToolsToServer } from "./create";

describe("shouldAddBaseToolsToServer", () => {
  test("skips the organization-wide mutation inside a Cloud agent runtime", () => {
    expect(
      shouldAddBaseToolsToServer(LETTA_CLOUD_API_URL, "agent-current"),
    ).toBe(false);
  });

  test("allows Cloud bootstrap outside an agent runtime", () => {
    expect(shouldAddBaseToolsToServer(LETTA_CLOUD_API_URL, undefined)).toBe(
      true,
    );
  });

  test("allows self-hosted bootstrap inside an agent runtime", () => {
    expect(
      shouldAddBaseToolsToServer("http://localhost:8283", "agent-current"),
    ).toBe(true);
  });
});
