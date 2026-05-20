import { describe, expect, test } from "bun:test";
import { readInteractiveAppSource } from "@/test-utils/read-interactive-app-source";

function readAppSource(): string {
  return readInteractiveAppSource();
}

describe("logout command wiring", () => {
  test("uses a dedicated logout message helper and checks process env", () => {
    const source = readAppSource();

    expect(source).toContain(
      'import { buildLogoutSuccessMessage } from "@/cli/helpers/logout-message"',
    );
    expect(source).toContain(
      "buildLogoutSuccessMessage(Boolean(process.env.LETTA_API_KEY))",
    );
  });
});
