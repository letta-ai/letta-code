import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HeadlessBackend } from "@/backend/dev/fake-headless-backend";

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error("Writer scheduling gate timed out");
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}

test.each(["agent", "conversation"])(
  "independent %s append requests cannot overwrite each other",
  async (kind) => {
    const directory = mkdtempSync(join(tmpdir(), "metadata-append-"));
    const backend = new HeadlessBackend("agent-test", undefined, {
      storageDir: directory,
    });
    const id =
      kind === "agent"
        ? "agent-test"
        : (await backend.createConversation({ agent_id: "agent-test" })).id;
    const ready = join(directory, "ready");
    const release = join(directory, "release");
    const contending = join(directory, "contending");
    const children: ReturnType<typeof spawn>[] = [];
    const exits: Promise<void>[] = [];
    let secondDone = false;
    function start(tag: string) {
      const child = spawn(
        process.execPath,
        [
          resolve(import.meta.dir, "local-metadata-writer.fixture.ts"),
          directory,
          kind,
          id,
          tag,
          ready,
          release,
          contending,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      children.push(child);
      let output = "";
      child.stdout?.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        output += chunk;
      });
      const exit = new Promise<void>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => {
          if (tag === "second") secondDone = true;
          if (code === 0) resolveExit();
          else reject(new Error(`Writer exited ${code}: ${output}`));
        });
      });
      void exit.catch(() => {});
      exits.push(exit);
    }
    try {
      start("first");
      await waitFor(() => existsSync(ready));
      start("second");
      // Fixed backend: the second process observes the held lock. Old backend:
      // it finishes its write, which the paused first process then overwrites.
      await waitFor(() => existsSync(contending) || secondDone);
      writeFileSync(release, "release");
      await Promise.all(exits);
      const result =
        kind === "agent"
          ? await backend.retrieveAgent(id)
          : await backend.retrieveConversation(id);
      expect(Reflect.get(result, "tags").sort()).toEqual(["first", "second"]);
    } finally {
      writeFileSync(release, "release");
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.allSettled(exits);
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
