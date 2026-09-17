import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimMemoryRepair, isMemoryRepairActive } from "./memory-repair-state";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function repository() {
  const root = mkdtempSync(join(tmpdir(), "memory-repair-state-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  return root;
}

test("claim ownership is visible to a separate process and release allows another job", async () => {
  const root = repository();
  const release = await claimMemoryRepair(root);
  expect(release).not.toBeNull();
  const script = `import { claimMemoryRepair, isMemoryRepairActive } from ${JSON.stringify(join(import.meta.dir, "memory-repair-state.ts"))};
    const root = process.argv[1];
    console.log(JSON.stringify({ active: await isMemoryRepairActive(root), claimed: Boolean(await claimMemoryRepair(root)) }));`;
  const child = Bun.spawn([process.execPath, "-e", script, root], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, error).toBe(0);
  expect(JSON.parse(output)).toEqual({ active: true, claimed: false });
  await release?.(true);
  expect(await isMemoryRepairActive(root)).toBe(false);
  const nextRelease = await claimMemoryRepair(root);
  expect(nextRelease).not.toBeNull();
  await nextRelease?.(true);
});

test("a dead process does not permanently block repairs", async () => {
  const root = repository();
  const child = Bun.spawn(
    [process.execPath, "-e", "console.log(process.pid)"],
    { stdout: "pipe" },
  );
  const output = await new Response(child.stdout).text();
  await child.exited;
  writeFileSync(
    join(root, ".git", "letta-memory-repair.json"),
    JSON.stringify({ pid: Number(output.trim()), retryAfter: 0 }),
  );
  expect(await isMemoryRepairActive(root)).toBe(false);
  const release = await claimMemoryRepair(root);
  expect(release).not.toBeNull();
  await release?.(true);
});

test("failed repairs back off and missing checkouts have no active repair", async () => {
  const root = repository();
  expect(await isMemoryRepairActive(join(root, "missing"))).toBe(false);
  const release = await claimMemoryRepair(root);
  await release?.(false);
  expect(await isMemoryRepairActive(root)).toBe(false);
  expect(await claimMemoryRepair(root)).toBeNull();
});
