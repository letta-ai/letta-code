import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import {
  getProcessStartTime,
  isPidReusedByNonLetta,
  isProcessAlive,
  isSameProcessRunning,
} from "./process-liveness";

test("this process is alive and an exited child is not", async () => {
  expect(isProcessAlive(process.pid)).toBe(true);
  const child = Bun.spawn(
    [process.execPath, "-e", "console.log(process.pid)"],
    {
      stdout: "pipe",
    },
  );
  const pid = Number(await new Response(child.stdout).text());
  await child.exited;
  expect(isProcessAlive(pid)).toBe(false);
  expect(isProcessAlive(0)).toBe(false);
});

test("a process start time is readable and stable", async () => {
  const first = await getProcessStartTime(process.pid);
  expect(first).not.toBeNull();
  expect(await getProcessStartTime(process.pid)).toBe(first);
  expect(await getProcessStartTime(0)).toBeNull();
});

test.skipIf(process.platform === "win32")(
  "a hung start-time lookup reports unknown instead of stalling",
  async () => {
    const bin = mkdtempSync(join(tmpdir(), "slow-ps-"));
    writeFileSync(join(bin, "ps"), "#!/bin/sh\nsleep 30\n");
    chmodSync(join(bin, "ps"), 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    try {
      const startedAt = Date.now();
      expect(await getProcessStartTime(process.pid)).toBeNull();
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    } finally {
      process.env.PATH = originalPath;
      rmSync(bin, { recursive: true, force: true });
    }
  },
);

test("a recorded start time distinguishes a reused pid from the original", async () => {
  const started = await getProcessStartTime(process.pid);
  expect(await isSameProcessRunning({ pid: process.pid })).toBe(true);
  expect(
    await isSameProcessRunning({ pid: process.pid, started: started ?? "" }),
  ).toBe(true);
  expect(
    await isSameProcessRunning({ pid: process.pid, started: "1970-01-01" }),
  ).toBe(false);
});

test("a reused pid is reclaimable only when positively identified as non-letta", () => {
  const reused = (command: string | null, pid = 999_999) =>
    isPidReusedByNonLetta(pid, () => command);
  expect(reused("/usr/libexec/unrelated --flag")).toBe(true);
  expect(reused("node /usr/local/bin/letta server")).toBe(false);
  // Dev/bun-run instances: same runtime or entry script, no "letta" in argv.
  expect(reused(`${process.execPath} run src/index.ts`)).toBe(false);
  expect(reused(`/elsewhere/${basename(process.execPath)} x.ts`)).toBe(false);
  expect(reused(`/usr/bin/env ${process.argv[1]}`)).toBe(false);
  // A failed lookup and our own pid keep the owner held.
  expect(reused(null)).toBe(false);
  expect(reused("/usr/libexec/unrelated", process.pid)).toBe(false);
});
