import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { createFileCommandSession } from "./file-commands";

function createHarness() {
  const sent: unknown[] = [];
  const tasks: Promise<void>[] = [];
  const session = createFileCommandSession({
    socket: {} as WebSocket,
    safeSocketSend: (_socket, payload) => {
      sent.push(payload);
      return true;
    },
    runDetachedListenerTask: (_commandName, task) => {
      tasks.push(task());
    },
  });
  return {
    sent,
    async send(command: Record<string, unknown>) {
      const handled = session.handle({ type: "write_file", ...command });
      await Promise.all(tasks.splice(0));
      return handled;
    },
  };
}

describe("listener write_file", () => {
  const tempDirs: string[] = [];
  const originalHome = process.env.HOME;

  afterEach(async () => {
    process.env.HOME = originalHome;
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "letta-write-file-"));
    tempDirs.push(root);
    return root;
  }

  test("utf8 writes keep the text path and response shape", async () => {
    const root = await tempRoot();
    const target = join(root, "nested", "notes.txt");
    const harness = createHarness();

    expect(
      await harness.send({ path: target, content: "hi\n", request_id: "r1" }),
    ).toBe(true);
    expect(await readFile(target, "utf8")).toBe("hi\n");
    expect(harness.sent[0]).toEqual({
      type: "write_file_response",
      request_id: "r1",
      path: target,
      success: true,
    });
  });

  test("base64 writes raw bytes, creates parent dirs, and reports size", async () => {
    const root = await tempRoot();
    const target = join(root, "a", "b", "image.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0d, 0x0a]);
    const harness = createHarness();

    await harness.send({
      path: target,
      content: bytes.toString("base64"),
      encoding: "base64",
      request_id: "r2",
    });
    expect(await readFile(target)).toEqual(bytes);
    expect(harness.sent[0]).toEqual({
      type: "write_file_response",
      request_id: "r2",
      path: target,
      bytes_written: bytes.length,
      success: true,
    });
  });

  test("base64 overwrites by default and appends chunks on request", async () => {
    const root = await tempRoot();
    const target = join(root, "file.bin");
    await writeFile(target, "stale contents");
    const harness = createHarness();

    await harness.send({
      path: target,
      content: Buffer.from([1, 2, 3]).toString("base64"),
      encoding: "base64",
      request_id: "c1",
    });
    await harness.send({
      path: target,
      content: Buffer.from([4, 5]).toString("base64"),
      encoding: "base64",
      append: true,
      request_id: "c2",
    });
    expect(await readFile(target)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    expect(harness.sent[1]).toMatchObject({ bytes_written: 2, success: true });
  });

  test("move_to publishes a chunked temporary file at its final path", async () => {
    const root = await tempRoot();
    const partial = join(root, "x.bin.partial-1");
    const target = join(root, "final", "x.bin");
    const harness = createHarness();

    await harness.send({
      path: partial,
      content: Buffer.from([1, 2]).toString("base64"),
      encoding: "base64",
      request_id: "m1",
    });
    await harness.send({
      path: partial,
      content: Buffer.from([3]).toString("base64"),
      encoding: "base64",
      append: true,
      move_to: target,
      request_id: "m2",
    });
    expect(await readFile(target)).toEqual(Buffer.from([1, 2, 3]));
    await expect(readFile(partial)).rejects.toThrow();
    expect(harness.sent[1]).toEqual({
      type: "write_file_response",
      request_id: "m2",
      path: target,
      bytes_written: 1,
      success: true,
    });
  });

  test("base64 resolves ~/ against the home directory", async () => {
    const home = await tempRoot();
    process.env.HOME = home;
    const harness = createHarness();

    await harness.send({
      path: "~/downloads/x.bin",
      content: Buffer.from("ok").toString("base64"),
      encoding: "base64",
      request_id: "h1",
    });
    const resolved = join(home, "downloads", "x.bin");
    expect(await readFile(resolved, "utf8")).toBe("ok");
    expect(harness.sent[0]).toMatchObject({ path: resolved, success: true });
  });

  test("rejects invalid base64, relative paths, and utf8 append", async () => {
    const root = await tempRoot();
    const harness = createHarness();

    await harness.send({
      path: join(root, "bad.bin"),
      content: "not base64!",
      encoding: "base64",
      request_id: "e1",
    });
    await harness.send({
      path: "relative.bin",
      content: "",
      encoding: "base64",
      request_id: "e2",
    });
    await harness.send({
      path: join(root, "text.txt"),
      content: "x",
      append: true,
      request_id: "e3",
    });
    expect(harness.sent).toEqual([
      expect.objectContaining({ request_id: "e1", success: false }),
      expect.objectContaining({ request_id: "e2", success: false }),
      expect.objectContaining({
        request_id: "e3",
        success: false,
        error: "write_file append/move_to require base64",
      }),
    ]);
  });

  test("rejects unknown encodings at the protocol boundary", async () => {
    const harness = createHarness();
    expect(
      await harness.send({
        path: "/tmp/x",
        content: "",
        encoding: "hex",
        request_id: "p1",
      }),
    ).toBe(false);
    expect(
      await harness.send({
        path: "/tmp/x",
        content: "",
        append: "yes",
        request_id: "p2",
      }),
    ).toBe(false);
    expect(harness.sent).toHaveLength(0);
  });
});
