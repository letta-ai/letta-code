import { expect, test } from "bun:test";
import {
  getProcessStartTime,
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
