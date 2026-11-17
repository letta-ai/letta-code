import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskReserve, setDiskReserve } from "@/utils/disk-reserve";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  createInterruptedTurnStore,
  recordListenerWork,
} from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";

const old = process.env.LETTA_MANAGED_CLOUD_RUNTIME;
let root: string;
afterEach(() => {
  setDiskReserve(null);
  if (old === undefined) delete process.env.LETTA_MANAGED_CLOUD_RUNTIME;
  else process.env.LETTA_MANAGED_CLOUD_RUNTIME = old;
  rmSync(root, { recursive: true, force: true });
});

test.each([false, true])(
  "tool-start record retries lock ENOSPC and fails closed on repeated failure (%s)",
  (alwaysFail) => {
    root = mkdtempSync(join(tmpdir(), "interrupted-reserve-"));
    process.env.LETTA_MANAGED_CLOUD_RUNTIME = "1";
    const reservePath = join(root, "reserve");
    const reserve = new DiskReserve(reservePath, () => {}, 4096);
    reserve.update({
      path: root,
      totalBytes: 20 * 1024 ** 3,
      availableBytes: 10 * 1024 ** 3,
    });
    setDiskReserve(reserve);
    expect(existsSync(reservePath)).toBe(true);
    const listener = createRuntime();
    listener.connectionId = "conn-test";
    const runtime = getOrCreateScopedRuntime(listener, "agent", "conversation");
    const store = createInterruptedTurnStore(join(root, "state"));
    const original = fs.mkdirSync;
    const error = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    let attempts = 0;
    const mkdir = spyOn(fs, "mkdirSync").mockImplementation((...args) => {
      if (String(args[0]).includes(".lock.candidate-")) {
        attempts++;
        if (alwaysFail || attempts === 1) throw error;
        expect(existsSync(reservePath)).toBe(false);
      }
      return Reflect.apply(original, fs, args);
    });
    try {
      const write = () =>
        recordListenerWork(
          runtime,
          { runId: "run-test", toolCallIds: ["tool-test"] },
          "before_tool_execution",
          undefined,
          undefined,
          store,
        );
      if (alwaysFail) {
        expect(write).toThrow(error);
        expect(store.read("agent", "conversation")).toBeNull();
      } else {
        const revision = write();
        expect(revision).toBeDefined();
        expect(store.read("agent", "conversation")).toMatchObject({
          revision,
          runId: "run-test",
          toolCallIds: ["tool-test"],
        });
      }
    } finally {
      mkdir.mockRestore();
    }
    expect(attempts).toBe(2);
    expect(existsSync(reservePath)).toBe(false);
  },
);
