import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTempGitRepo,
  type TempGitRepo,
} from "@/test-utils/temp-git-repo";
import { getProcessStartTime } from "@/utils/process-liveness";
import { claimMemoryOperation, withMemoryOperation } from "./memory-operation";

const repos: TempGitRepo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});
function repository(): string {
  const repo = createTempGitRepo("memory-operation-");
  repos.push(repo);
  return repo.dir;
}
const lockPath = (root: string) =>
  join(root, ".git", "letta-memory-operation.lock");
const claimFromChild = (root: string, env: NodeJS.ProcessEnv = process.env) =>
  Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { claimMemoryOperation } from ${JSON.stringify(join(import.meta.dir, "memory-operation.ts"))}; console.log(await claimMemoryOperation(process.argv[1]) === null);`,
      root,
    ],
    { stdout: "pipe", stderr: "pipe", env },
  );

test("a separate process cannot claim an owned checkout", async () => {
  const root = repository();
  const release = await claimMemoryOperation(root);
  const child = claimFromChild(root);
  expect(await child.exited).toBe(0);
  expect((await new Response(child.stdout).text()).trim()).toBe("true");
  await release?.();
  const next = await claimMemoryOperation(root);
  expect(next).not.toBeNull();
  await next?.();
});

test("the record is published whole and the holder's start time is timezone-invariant", async () => {
  const root = repository();
  const release = await claimMemoryOperation(root);
  expect(JSON.parse(readFileSync(lockPath(root), "utf8"))).toMatchObject({
    pid: process.pid,
    started: await getProcessStartTime(process.pid),
  });
  expect(
    readdirSync(join(root, ".git")).filter((f) => f.endsWith(".tmp")),
  ).toEqual([]);
  const other = claimFromChild(root, { ...process.env, TZ: "Asia/Kolkata" });
  expect(await other.exited).toBe(0);
  expect((await new Response(other.stdout).text()).trim()).toBe("true");
  await release?.();
});

test("reclaims a checkout whose holder exited", async () => {
  const root = repository();
  const child = Bun.spawn(
    [process.execPath, "-e", "console.log(process.pid)"],
    { stdout: "pipe" },
  );
  const pid = Number(await new Response(child.stdout).text());
  await child.exited;
  writeFileSync(
    lockPath(root),
    JSON.stringify({ pid, started: "1970-01-01", acquiredAt: Date.now() }),
  );
  const release = await claimMemoryOperation(root);
  expect(release).not.toBeNull();
  await release?.();
});

test("reclaims a checkout whose pid now belongs to another process", async () => {
  const root = repository();
  // Our own pid is alive, but the recorded start time is not ours: the pid was reused.
  writeFileSync(
    lockPath(root),
    JSON.stringify({
      pid: process.pid,
      started: "1970-01-01",
      acquiredAt: Date.now(),
    }),
  );
  const release = await claimMemoryOperation(root);
  expect(release).not.toBeNull();
  expect(await claimMemoryOperation(root)).toBeNull();
  await release?.();
});

test("an unreadable lock file does not wedge the checkout", async () => {
  const root = repository();
  writeFileSync(lockPath(root), "{not json");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockPath(root), old, old);
  const release = await claimMemoryOperation(root);
  expect(release).not.toBeNull();
  await release?.();
});

test.skipIf(process.platform === "win32")(
  "a paused holder keeps its checkout",
  async () => {
    const root = repository();
    const holder = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { claimMemoryOperation } from ${JSON.stringify(join(import.meta.dir, "memory-operation.ts"))}; await claimMemoryOperation(process.argv[1]); console.log("held"); setInterval(() => {}, 1000);`,
        root,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      const reader = holder.stdout.getReader();
      await reader.read();
      reader.releaseLock();
      holder.kill("SIGSTOP");
      expect(await claimMemoryOperation(root)).toBeNull();
    } finally {
      holder.kill("SIGKILL");
      await holder.exited;
    }
  },
);

test("cancelling a waiting operation does not release someone else's checkout", async () => {
  const root = repository();
  const release = await claimMemoryOperation(root);
  const controller = new AbortController();
  const waiting = withMemoryOperation(
    root,
    async () => {
      throw new Error("must not run");
    },
    controller.signal,
  );
  controller.abort();
  await expect(waiting).rejects.toThrow();
  expect(await claimMemoryOperation(root)).toBeNull();
  await release?.();
});

test("a follow-up operation started inside another still waits its turn", async () => {
  const root = repository();
  let followup: Promise<void> | undefined;
  let ran = false;
  await withMemoryOperation(root, async () => {
    followup = withMemoryOperation(root, async () => {
      ran = true;
    });
    await Bun.sleep(50);
    expect(ran).toBe(false);
  });
  await followup;
  expect(ran).toBe(true);
});
