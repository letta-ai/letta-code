import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimMemoryOperation, withMemoryOperation } from "./memory-operation";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function repository() {
  const root = mkdtempSync(join(tmpdir(), "memory-operation-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  return root;
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
