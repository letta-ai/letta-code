import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startCheckout,
  waitForCheckouts,
  waitForToolCheckouts,
} from "./checkout-readiness";
import { withRepositoryCheckout } from "./repository-checkout";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function git(args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(child.stderr).text();
  if (await child.exited) throw new Error(stderr);
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "letta-checkout-real-"));
  directories.push(directory);
  const source = join(directory, "source");
  await git(["init", "-b", "main", source]);
  // Clone assertions test publication, not the runner's newline policy.
  await writeFile(join(source, ".gitattributes"), "memory.txt text eol=lf\n");
  await writeFile(join(source, "memory.txt"), "complete memory\n");
  await git(["-C", source, "add", ".gitattributes", "memory.txt"]);
  await git([
    "-C",
    source,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  ]);
  return {
    directory,
    source,
    target: join(directory, "archive"),
    agent: `agent-${directory}`,
  };
}

test("publishes the checkout only after real Git clone and setup finish", async () => {
  const { source, target } = await fixture();
  const cloned = barrier();
  const publish = barrier();
  const pending = withRepositoryCheckout(target, async (staging, fresh) => {
    expect(fresh).toBe(true);
    await git(["clone", source, staging]);
    cloned.release();
    await publish.promise;
    await writeFile(join(staging, ".git", "setup-complete"), "ready");
  });
  try {
    await cloned.promise;
    expect(existsSync(target)).toBe(false);
  } finally {
    publish.release();
  }
  await pending;
  expect(await readFile(join(target, "memory.txt"), "utf8")).toBe(
    "complete memory\n",
  );
  expect(await readFile(join(target, ".git", "setup-complete"), "utf8")).toBe(
    "ready",
  );
});

test("failed setup never exposes a clone and a later attempt succeeds", async () => {
  const { source, target } = await fixture();
  await expect(
    withRepositoryCheckout(target, async (staging) => {
      await git(["clone", source, staging]);
      throw new Error("setup failed");
    }),
  ).rejects.toThrow("setup failed");
  expect(existsSync(target)).toBe(false);
  await withRepositoryCheckout(target, (staging) =>
    git(["clone", source, staging]),
  );
  expect(await readFile(join(target, "memory.txt"), "utf8")).toBe(
    "complete memory\n",
  );
});

test("concurrent publishers serialize and preserve the completed checkout", async () => {
  const { source, target } = await fixture();
  let clones = 0;
  const work = (staging: string, fresh: boolean) => {
    if (!fresh) return Promise.resolve();
    clones++;
    return git(["clone", source, staging]);
  };
  await Promise.all([
    withRepositoryCheckout(target, work),
    withRepositoryCheckout(target, work),
  ]);
  expect(clones).toBe(1);
  expect(await readFile(join(target, "memory.txt"), "utf8")).toBe(
    "complete memory\n",
  );
});

test("background archive clone does not gate unrelated files but gates dependent file and shell tools", async () => {
  const { directory, source, target, agent } = await fixture();
  const release = barrier();
  const started = barrier();
  let clones = 0;
  const clone = () =>
    withRepositoryCheckout(target, async (staging) => {
      clones++;
      started.release();
      await release.promise;
      await git(["clone", source, staging]);
    });
  const first = startCheckout(agent, target, clone);
  const second = startCheckout(agent, target, clone);
  expect(second).toBe(first);
  await started.promise;
  let fileReady = false;
  let shellReady = false;
  const file = waitForToolCheckouts(
    agent,
    "Read",
    { file_path: join(target, "memory.txt") },
    directory,
  ).then(() => {
    fileReady = true;
  });
  const shell = waitForToolCheckouts(
    agent,
    "Bash",
    { command: "python script.py" },
    directory,
  ).then(() => {
    shellReady = true;
  });
  try {
    await waitForToolCheckouts(
      agent,
      "Read",
      { file_path: join(directory, "project.txt") },
      directory,
    );
    expect(fileReady).toBe(false);
    expect(shellReady).toBe(false);
    expect(existsSync(target)).toBe(false);
  } finally {
    release.release();
  }
  await Promise.all([first, second, file, shell]);
  expect(clones).toBe(1);
  expect(fileReady).toBe(true);
  expect(shellReady).toBe(true);
});

test("dependent access retries a failed background checkout without a mock transport", async () => {
  const { source, target, agent } = await fixture();
  let attempts = 0;
  const clone = () =>
    withRepositoryCheckout(target, async (staging) => {
      attempts++;
      await git([
        "clone",
        attempts === 1 ? `${source}-missing` : source,
        staging,
      ]);
    });
  await expect(startCheckout(agent, target, clone)).rejects.toThrow();
  expect(existsSync(target)).toBe(false);
  await waitForCheckouts(agent, [join(target, "memory.txt")]);
  expect(attempts).toBe(2);
  expect(await readFile(join(target, "memory.txt"), "utf8")).toBe(
    "complete memory\n",
  );
});

test("a failed pull leaves the existing checkout accessible for repair", async () => {
  const { source, target, agent } = await fixture();
  await git(["clone", source, target]);
  await writeFile(join(target, "memory.txt"), "local edit\n");
  await writeFile(join(source, "memory.txt"), "upstream edit\n");
  await git(["-C", source, "add", "memory.txt"]);
  await git([
    "-C",
    source,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "upstream edit",
  ]);
  let attempts = 0;
  const sync = () =>
    withRepositoryCheckout(target, async (directory) => {
      attempts++;
      await git(["-C", directory, "pull", "--ff-only"]);
    });
  await expect(startCheckout(agent, target, sync)).rejects.toThrow();
  await waitForToolCheckouts(
    agent,
    "Read",
    { file_path: join(target, "memory.txt") },
    target,
  );
  await waitForToolCheckouts(agent, "Bash", { command: "git diff" }, target);
  await git(["-C", target, "diff"]);
  expect(attempts).toBe(1);
  expect(await readFile(join(target, "memory.txt"), "utf8")).toBe(
    "local edit\n",
  );
});
