import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTempGitRepo,
  type TempGitRepo,
} from "@/test-utils/temp-git-repo";
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
test("a separate process cannot mutate an owned checkout", async () => {
  const root = repository();
  const release = await claimMemoryOperation(root);
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { claimMemoryOperation } from ${JSON.stringify(join(import.meta.dir, "memory-operation.ts"))}; console.log(await claimMemoryOperation(process.argv[1]) === null);`,
      root,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await child.exited).toBe(0);
  expect((await new Response(child.stdout).text()).trim()).toBe("true");
  await release?.();
  const next = await claimMemoryOperation(root);
  expect(next).not.toBeNull();
  await next?.();
});
test("reclaims ownership after its process exits", async () => {
  const root = repository();
  const child = Bun.spawn(
    [process.execPath, "-e", "console.log(process.pid)"],
    { stdout: "pipe" },
  );
  const pid = Number(await new Response(child.stdout).text());
  await child.exited;
  writeFileSync(
    join(root, ".git", "letta-memory-operation.json"),
    JSON.stringify({ pid, token: "dead" }),
  );
  const release = await claimMemoryOperation(root);
  expect(release).not.toBeNull();
  await release?.();
});
test("cancelling a waiting worker does not release someone else's ownership", async () => {
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

test("a follow-up worker launched inside another operation still waits its turn", async () => {
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

test("a lease whose pid now belongs to another process is reclaimed", async () => {
  const root = repository();
  const path = join(root, ".git", "letta-memory-operation.json");
  // Our own pid is alive, but the recorded start time is not ours: the pid was reused.
  writeFileSync(
    path,
    JSON.stringify({
      pid: process.pid,
      token: "reused",
      started: "1970-01-01",
    }),
  );
  const release = await claimMemoryOperation(root);
  expect(release).not.toBeNull();
  expect(await claimMemoryOperation(root)).toBeNull();
  await release?.();
});

test.skipIf(process.platform === "win32")(
  "a paused holder keeps its lease",
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
      // Stop the holder outright: no heartbeat could ever be sent from here.
      holder.kill("SIGSTOP");
      expect(await claimMemoryOperation(root)).toBeNull();
    } finally {
      holder.kill("SIGKILL");
      await holder.exited;
    }
  },
);

test("an unreadable owner file does not wedge the checkout", async () => {
  const root = repository();
  writeFileSync(join(root, ".git", "letta-memory-operation.json"), "{not json");
  const release = await claimMemoryOperation(root);
  expect(release).not.toBeNull();
  await release?.();
});

test("the recorded start time does not depend on the holder's timezone", async () => {
  const root = repository();
  const release = await claimMemoryOperation(root);
  const other = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { claimMemoryOperation } from ${JSON.stringify(join(import.meta.dir, "memory-operation.ts"))}; console.log(await claimMemoryOperation(process.argv[1]) === null);`,
      root,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TZ: "Asia/Kolkata" },
    },
  );
  expect(await other.exited).toBe(0);
  expect((await new Response(other.stdout).text()).trim()).toBe("true");
  await release?.();
});

test("a lease taken while the guard was reaped is not overwritten", async () => {
  const root = repository();
  const path = join(root, ".git", "letta-memory-operation.json");
  // Simulate the reaped-guard race: another live process wrote its owner file
  // after this process had already decided the checkout was free.
  const guard = `${path}.lock`;
  const { withFileLock } = await import("@/utils/file-lock");
  let secondOwner = false;
  await withFileLock(guard, async () => {
    writeFileSync(
      path,
      JSON.stringify({ pid: process.pid, token: "second-owner" }),
    );
    secondOwner = true;
  });
  expect(secondOwner).toBe(true);
  // The late acquirer must lose: the owner file still names the second owner.
  expect(await claimMemoryOperation(root)).toBeNull();
  expect(JSON.parse(readFileSync(path, "utf8")).token).toBe("second-owner");
});

test("a published owner file is never partially written", async () => {
  const root = repository();
  const path = join(root, ".git", "letta-memory-operation.json");
  const release = await claimMemoryOperation(root);
  // Only the complete record is ever visible at the lease path.
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
    pid: process.pid,
  });
  expect(
    readdirSync(join(root, ".git")).filter((f) => f.endsWith(".tmp")),
  ).toEqual([]);
  await release?.();
});
