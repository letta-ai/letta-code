import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createSigintAbortController } from "@/utils/sigint-abort";

describe("createSigintAbortController", () => {
  test("aborts the signal when SIGINT is delivered", () => {
    const proc = new EventEmitter();
    const sigintAbort = createSigintAbortController(proc);

    expect(sigintAbort.signal.aborted).toBe(false);
    proc.emit("SIGINT");
    expect(sigintAbort.signal.aborted).toBe(true);
  });

  test("only registers a once-listener", () => {
    const proc = new EventEmitter();
    createSigintAbortController(proc);

    proc.emit("SIGINT");
    expect(proc.listenerCount("SIGINT")).toBe(0);
  });

  test("dispose removes the listener without aborting", () => {
    const proc = new EventEmitter();
    const sigintAbort = createSigintAbortController(proc);

    sigintAbort.dispose();
    proc.emit("SIGINT");

    expect(sigintAbort.signal.aborted).toBe(false);
    expect(proc.listenerCount("SIGINT")).toBe(0);
  });
});
