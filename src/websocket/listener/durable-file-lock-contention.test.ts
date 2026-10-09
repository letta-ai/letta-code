import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("concurrent lock publication is not mistaken for corrupt ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "letta-lock-contention-"));
  const modulePath = join(import.meta.dir, "durable-file-lock.ts");
  const script = `
    import { acquireDurableFileLock } from ${JSON.stringify(modulePath)};
    const errors = [];
    for (let i = 0; i < 150; i++) {
      try {
        const release = acquireDurableFileLock(${JSON.stringify(join(root, "ledger"))});
        release();
      } catch (error) { errors.push(String(error)); }
    }
    console.log(JSON.stringify(errors));
  `;
  const children = Array.from({ length: 16 }, () =>
    Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  try {
    const results = await Promise.all(
      children.map(async (child) => ({
        output: await new Response(child.stdout).text(),
        errors: await new Response(child.stderr).text(),
        code: await child.exited,
      })),
    );
    for (const result of results) {
      expect(result.code).toBe(0);
      expect(result.errors).toBe("");
      expect(JSON.parse(result.output)).toEqual([]);
    }
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => child.exited));
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
