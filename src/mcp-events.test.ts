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

test("prefers stdio push, ignores another stream and sends cancellation on stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-events-push-"));
  const transcript = join(dir, "wire.jsonl");
  const connection = await connectMcpEvents({
    name: "example",
    command: process.execPath,
    args: [fixture, transcript],
  });
  const stop = new AbortController();
  try {
    const delivered: string[] = [];
    await connection.watch(
      "issue.updated",
      {},
      (notice) => {
        if (notice.type !== "event") return;
        delivered.push(notice.event.eventId);
        stop.abort();
      },
      AbortSignal.any([stop.signal, AbortSignal.timeout(3000)]),
    );
    expect(delivered).toEqual(["push-1"]);
    const waitUntil = Date.now() + 1500;
    while (
      !readFileSync(transcript, "utf8").includes("notifications/cancelled") &&
      Date.now() < waitUntil
    ) {
      await Bun.sleep(10);
    }
    const requests = readFileSync(transcript, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const stream = requests.find(
      (message) => message.method === "events/stream",
    );
    expect(stream?.params.cursor).toBeNull();
    expect(requests.some((message) => message.method === "events/poll")).toBe(
      false,
    );
    expect(
      requests.find((message) => message.method === "notifications/cancelled")
        ?.params.requestId,
    ).toBe(stream?.id);
  } finally {
    await connection.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
