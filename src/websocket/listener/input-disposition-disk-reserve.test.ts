import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskReserve, setDiskReserve } from "@/utils/disk-reserve";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  createAcceptedInputDispositionLedger,
  durableTransaction,
  ordinaryInputIdentity,
  reserveInputDisposition,
} from "./input-disposition";
import { createRuntime } from "./lifecycle";

const root = mkdtempSync(join(tmpdir(), "ledger-reserve-"));
const old = process.env.LETTA_MANAGED_CLOUD_RUNTIME;
afterEach(() => {
  setDiskReserve(null);
  if (old === undefined) delete process.env.LETTA_MANAGED_CLOUD_RUNTIME;
  else process.env.LETTA_MANAGED_CLOUD_RUNTIME = old;
  rmSync(root, { recursive: true, force: true });
});

function setup() {
  process.env.LETTA_MANAGED_CLOUD_RUNTIME = "1";
  const path = join(root, "reserve");
  const reserve = new DiskReserve(path, () => {}, 4096);
  reserve.update({
    path: tmpdir(),
    totalBytes: 20 * 1024 ** 3,
    availableBytes: 10 * 1024 ** 3,
  });
  setDiskReserve(reserve);
  return path;
}

test("ledger transaction retries ENOSPC after releasing real reserve", () => {
  const reservePath = setup();
  let attempts = 0;
  const path = join(root, "ledger.json");
  const result = durableTransaction(path, (store) => {
    if (++attempts === 1)
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    store.nextGeneration++;
    return { changed: true, result: store.nextGeneration };
  });
  expect(attempts).toBe(2);
  expect(result).toBe(1);
  expect(existsSync(reservePath)).toBe(false);
  expect(
    durableTransaction(path, (store) => ({
      changed: false,
      result: store.nextGeneration,
    })),
  ).toBe(1);
});

test("ledger retry failure propagates and never runs a third time", () => {
  setup();
  let attempts = 0;
  const error = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  expect(() =>
    durableTransaction(join(root, "ledger.json"), () => {
      attempts++;
      throw error;
    }),
  ).toThrow(error);
  expect(attempts).toBe(2);
});

test("other ledger errors do not release reserve or retry", () => {
  const reservePath = setup();
  let attempts = 0;
  expect(() =>
    durableTransaction(join(root, "ledger.json"), () => {
      attempts++;
      throw new Error("permission denied");
    }),
  ).toThrow("permission denied");
  expect(attempts).toBe(1);
  expect(existsSync(reservePath)).toBe(true);
});

test.each([false, true])(
  "admission retries mkdir ENOSPC and preserves full result on repeated failure (%s)",
  (alwaysFail) => {
    setup();
    const listener = createRuntime();
    listener.acceptedInputDispositionLedger =
      createAcceptedInputDispositionLedger({
        persistentPath: join(root, "ledger.json"),
      });
    const runtime = getOrCreateScopedRuntime(listener, "agent", "conversation");
    const original = fs.mkdirSync;
    let attempts = 0;
    const mkdir = spyOn(fs, "mkdirSync").mockImplementation((...args) => {
      if (String(args[0]).includes(".lock.candidate-")) {
        attempts++;
        if (alwaysFail || attempts === 1)
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
      return Reflect.apply(original, fs, args);
    });
    let result: ReturnType<typeof reserveInputDisposition>;
    try {
      result = reserveInputDisposition(
        runtime,
        ordinaryInputIdentity("input-1"),
      );
    } finally {
      mkdir.mockRestore();
    }
    expect(attempts).toBe(2);
    expect(result.kind).toBe(alwaysFail ? "full" : "reserved");
    expect(existsSync(join(root, "reserve"))).toBe(false);
  },
);
