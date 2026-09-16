import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import {
  getCheckoutGeneration,
  isCheckoutPending,
  retainCheckouts,
  startCheckout,
  trackCheckoutDiscovery,
  waitForCheckouts,
  waitForToolCheckouts,
} from "./checkout-readiness";

test.each([
  "RunShellCommand",
  "run_shell_command",
  "ShellCommand",
  "shell_command",
  "Bash",
  "exec_command",
  "write_stdin",
  "Shell",
  "shell",
  "Monitor",
  "Skill",
  "Replace",
  "replace",
  "view_image",
  "ViewImage",
  "LS",
  "Read",
  "Write",
  "ReadFileGemini",
  "WriteFileGemini",
  "ReadManyFiles",
  "ListDirectory",
  "GlobGemini",
  "SearchFileContent",
  "ApplyPatch",
  "apply_patch",
])("%s waits for its unpublished checkout", async (name) => {
  const agent = crypto.randomUUID();
  const root = join(tmpdir(), agent);
  let release!: () => void;
  const clone = startCheckout(
    agent,
    root,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  let completed = false;
  const access = waitForToolCheckouts(
    agent,
    name,
    {
      command: "pwd",
      file_path: join(root, "file.md"),
      path: root,
      input: `*** Begin Patch\n*** Add File: ${join(root, "file.md")}\n+hello\n*** End Patch`,
    },
    tmpdir(),
  ).then(() => {
    completed = true;
  });
  try {
    await nextTick();
    expect(completed).toBe(false);
  } finally {
    release();
    await Promise.all([clone, access]);
    retainCheckouts(agent, []);
  }
  expect(completed).toBe(true);
});

test("Read and Write wait after home and environment expansion", async () => {
  const agent = crypto.randomUUID();
  const root = join(homedir(), agent);
  const key = "LETTA_CHECKOUT_TEST_PATH";
  const previous = process.env[key];
  process.env[key] = root;
  let release!: () => void;
  const clone = startCheckout(
    agent,
    root,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  let completed = 0;
  const accesses = ["Read", "Write"].flatMap((name) =>
    [`~/${agent}/file.md`, `$${key}/file.md`, `\${${key}}/file.md`].map(
      (file_path) =>
        waitForToolCheckouts(agent, name, { file_path }, tmpdir()).then(() => {
          completed++;
        }),
    ),
  );
  try {
    await nextTick();
    expect(completed).toBe(0);
  } finally {
    release();
    await Promise.all([clone, ...accesses]);
    retainCheckouts(agent, []);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  expect(completed).toBe(6);
});

test("failed optional discovery does not disable local tools and retries later", async () => {
  const agent = crypto.randomUUID();
  let attempts = 0;
  await expect(
    trackCheckoutDiscovery(agent, async () => {
      attempts++;
      if (attempts < 3) throw new Error("repository endpoint unavailable");
    }),
  ).rejects.toThrow("repository endpoint unavailable");
  await waitForToolCheckouts(
    agent,
    "Read",
    { file_path: join(tmpdir(), "project.md") },
    tmpdir(),
  );
  await waitForToolCheckouts(agent, "Bash", { command: "pwd" }, tmpdir());
  expect(attempts).toBe(3);
});

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
