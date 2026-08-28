import { describe, expect, test } from "bun:test";
import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import { shouldAddBaseToolsToServer } from "./create";

describe("shouldAddBaseToolsToServer", () => {
  test("skips the organization-wide mutation inside a managed Cloud runtime", () => {
    expect(
      shouldAddBaseToolsToServer(LETTA_CLOUD_API_URL, "device-managed"),
    ).toBe(false);
  });

  test("allows Cloud bootstrap outside a managed runtime", () => {
    expect(shouldAddBaseToolsToServer(LETTA_CLOUD_API_URL, undefined)).toBe(
      true,
    );
  });

  test("allows self-hosted bootstrap inside a managed runtime", () => {
    expect(
      shouldAddBaseToolsToServer("http://localhost:8283", "device-managed"),
    ).toBe(true);
  });
});
