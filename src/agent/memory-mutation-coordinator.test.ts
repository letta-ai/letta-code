import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enqueueMemoryWriterLane,
  memoryMutationLockDir,
  withMemoryMutationLock,
} from "@/agent/memory-mutation-coordinator";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("memory mutation coordinator", () => {
  test("serializes lock holders for one checkout", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memory-mutation-lock-"));
    const memoryDir = join(tempDir, "memory");
    const order: string[] = [];

    await Promise.all([
      withMemoryMutationLock(memoryMutationLockDir(memoryDir), async () => {
        order.push("a-start");
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push("a-end");
      }),
      withMemoryMutationLock(memoryMutationLockDir(memoryDir), async () => {
        order.push("b-start");
        order.push("b-end");
      }),
    ]);

    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  test("runs one writer lane per agent", async () => {
    const order: string[] = [];
    await Promise.all([
      enqueueMemoryWriterLane("agent-a", async () => {
        order.push("a-start");
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("a-end");
      }),
      enqueueMemoryWriterLane("agent-a", async () => {
        order.push("b");
      }),
    ]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });
});
