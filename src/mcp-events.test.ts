import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectMcpEvents } from "./mcp-events";

const fixture = fileURLToPath(
  new URL("./fixtures/mcp-events-server.mjs", import.meta.url),
);

test("never requests events without the advertised capability", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-events-"));
  const transcript = join(dir, "wire.jsonl");
  try {
    await expect(
      connectMcpEvents({
        name: "example",
        command: process.execPath,
        args: [fixture, transcript, "absent"],
      }),
    ).rejects.toThrow("does not advertise the Events extension");
    const methods = readFileSync(transcript, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).method);
    expect(methods).toEqual(["server/discover"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
