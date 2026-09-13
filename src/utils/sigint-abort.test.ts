import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createSigintAbortSignal } from "@/utils/sigint-abort";

describe("createSigintAbortSignal", () => {
  test("aborts the signal when SIGINT is delivered", () => {
    const proc = new EventEmitter();
    const signal = createSigintAbortSignal(proc);

    expect(signal.aborted).toBe(false);
    proc.emit("SIGINT");
    expect(signal.aborted).toBe(true);
  });

  test("only registers a once-listener", () => {
    const proc = new EventEmitter();
    createSigintAbortSignal(proc);

    proc.emit("SIGINT");
    expect(proc.listenerCount("SIGINT")).toBe(0);
  });
});
