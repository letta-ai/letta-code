import { describe, expect, test } from "bun:test";
import { readInteractiveAppSource } from "@/tests/helpers/readInteractiveAppSource";

function readAppSource(): string {
  return readInteractiveAppSource();
}

describe("logout command wiring", () => {
  test("uses a dedicated logout message helper and checks process env", () => {
    const source = readAppSource();

    expect(source).toContain(
      'import { buildLogoutSuccessMessage } from "@/cli/helpers/logoutMessage"',
    );
    expect(source).toContain(
      "buildLogoutSuccessMessage(Boolean(process.env.LETTA_API_KEY))",
    );
  });
});
