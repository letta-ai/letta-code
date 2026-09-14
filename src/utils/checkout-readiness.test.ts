import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCheckoutGeneration,
  isCheckoutPending,
  retainCheckouts,
  startCheckout,
  trackCheckoutDiscovery,
  waitForCheckouts,
  waitForToolCheckouts,
} from "./checkout-readiness";

test("background checkouts do not gate unrelated file access; repository access waits", async () => {
  const root = await mkdtemp(join(tmpdir(), "checkout-ready-"));
  const agent = root;
  const repository = join(root, "shared");
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let runs = 0;
  const generation = getCheckoutGeneration();
  const pending = startCheckout(agent, repository, async () => {
    runs++;
    await barrier;
    await writeFile(join(root, "completed"), "ready");
  });
  try {
    expect(isCheckoutPending(repository)).toBe(true);
    await waitForToolCheckouts(
      agent,
      "Read",
      { file_path: "/unrelated/file" },
      "/unrelated",
    );
    await waitForToolCheckouts(
      agent,
      "Grep",
      { path: "/unrelated", pattern: "hello" },
      root,
    );
    let accessed = false;
    const access = waitForCheckouts(agent, [
      join(repository, "MEMORY.md"),
    ]).then(() => {
      accessed = true;
    });
    await Promise.resolve();
    expect(accessed).toBe(false);
    release();
    await Promise.all([pending, access]);
    expect(await readFile(join(root, "completed"), "utf8")).toBe("ready");
    expect(runs).toBe(1);
    expect(isCheckoutPending(repository)).toBe(false);
    expect(getCheckoutGeneration()).toBeGreaterThan(generation);
  } finally {
    release();
    await pending;
    await rm(root, { recursive: true, force: true });
  }
});

test("shell access waits for discovery and retries a failed checkout", async () => {
  const agent = `retry-${crypto.randomUUID()}`;
  const path = `/tmp/${agent}/shared`;
  let attempts = 0;
  const operation = async () => {
    if (++attempts === 1) throw new Error("unavailable");
  };
  await expect(startCheckout(agent, path, operation)).rejects.toThrow(
    "unavailable",
  );
  await waitForToolCheckouts(
    agent,
    "exec_command",
    { cmd: "python script.py" },
    "/tmp",
  );
  expect(attempts).toBe(2);
  let release!: () => void;
  trackCheckoutDiscovery(
    agent,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  let finished = false;
  const access = waitForToolCheckouts(
    agent,
    "Bash",
    { command: "ls" },
    "/tmp",
  ).then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  release();
  await access;
  expect(finished).toBe(true);
});

test("detached failed checkouts no longer gate shell access", async () => {
  const agent = `detached-${crypto.randomUUID()}`;
  await expect(
    startCheckout(agent, `/tmp/${agent}`, async () => {
      throw new Error("unavailable");
    }),
  ).rejects.toThrow("unavailable");
  retainCheckouts(agent, []);
  await waitForToolCheckouts(agent, "Bash", { command: "ls" }, "/tmp");
});

test("patch headers and symlinked file destinations wait for the actual checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "checkout-alias-"));
  const real = join(root, "real");
  const alias = join(root, "alias");
  await mkdir(real);
  await symlink(real, alias);
  const checkout = join(real, "shared");
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = startCheckout(root, checkout, async () => {
    await barrier;
  });
  let completed = 0;
  const patch = waitForToolCheckouts(
    root,
    "ApplyPatch",
    {
      input: `*** Begin Patch\n*** Add File: ${alias}/shared/new.md\n+hello\n*** End Patch`,
    },
    root,
  ).then(() => {
    completed++;
  });
  const read = waitForToolCheckouts(
    root,
    "Read",
    { file_path: `${alias}/shared/MEMORY.md` },
    root,
  ).then(() => {
    completed++;
  });
  try {
    await waitForToolCheckouts(
      root,
      "ApplyPatch",
      {
        input:
          "*** Begin Patch\n*** Add File: /unrelated/new.md\n+hello\n*** End Patch",
      },
      root,
    );
    expect(completed).toBe(0);
    release();
    await Promise.all([pending, patch, read]);
    expect(completed).toBe(2);
  } finally {
    release();
    await pending;
    await rm(root, { recursive: true, force: true });
  }
});
