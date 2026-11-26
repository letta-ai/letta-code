import { afterAll, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

const spawn = mock(() => {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number;
    stdout: EventEmitter & { setEncoding(encoding: string): EventEmitter };
    stderr: EventEmitter & { setEncoding(encoding: string): EventEmitter };
  };
  child.stdout = Object.assign(new EventEmitter(), {
    setEncoding(this: EventEmitter) {
      return this;
    },
  });
  child.stderr = Object.assign(new EventEmitter(), {
    setEncoding(this: EventEmitter) {
      return this;
    },
  });

  queueMicrotask(() => {
    const error = Object.assign(new Error("spawn git ENOENT"), {
      code: "ENOENT",
    });
    child.emit("error", error);
    child.emit("close", null, null);
  });
  return child;
});

mock.module("node:child_process", () => ({ spawn }));

const { execGit } = await import("@/agent/memory-git-process");

afterAll(() => mock.restore());

test("explains when Git is missing from PATH", async () => {
  const result = await execGit([], {
    cwd: "/tmp",
    env: {},
    timeoutMs: 0,
  }).catch((error: unknown) => error);

  expect(result).toBeInstanceOf(Error);
  if (!(result instanceof Error)) {
    throw new Error("Expected execGit to reject");
  }

  expect(result.message).toBe(
    "Letta's local memory needs Git, but `git` wasn't found on PATH. Install Git (https://git-scm.com/downloads) and restart.",
  );
  expect(result.cause).toMatchObject({
    code: "ENOENT",
    message: "spawn git ENOENT",
  });
});
