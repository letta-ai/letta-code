import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readAppSource(): string {
  const appPath = fileURLToPath(new URL("../../cli/App.tsx", import.meta.url));
  return readFileSync(appPath, "utf-8");
}

describe("logout command wiring", () => {
  test("uses a dedicated logout message helper and checks process env", () => {
    const source = readAppSource();

    expect(source).toContain(
      'import { buildLogoutSuccessMessage } from "./helpers/logoutMessage";',
    );
    expect(source).toContain(
      "buildLogoutSuccessMessage(Boolean(process.env.LETTA_API_KEY))",
    );
  });
});
