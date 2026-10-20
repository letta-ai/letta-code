import { describe, expect, spyOn, test } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  isMissingCwdGitError,
  isRetryableGitTransientError,
  runGitWithRetry,
} from "@/agent/memory-git";
import { withPeerSeed } from "./memory-git-seed";

describe("isRetryableGitTransientError", () => {
  test.each([
    "fatal: unable to access 'https://api.letta.com/state.git/': The requested URL returned error: 503",
    "error: RPC failed; HTTP 503 curl 22 The requested URL returned error: 503",
  ])("retries service unavailable: %s", (message) => {
    expect(isRetryableGitTransientError(new Error(message))).toBe(true);
  });

  test("returns true for Cloudflare 52x HTTP errors", () => {
    expect(
      isRetryableGitTransientError(
        new Error(
          "fatal: unable to access 'https://api.letta.com/...': The requested URL returned error: 521",
        ),
      ),
    ).toBe(true);

    expect(
      isRetryableGitTransientError(
        new Error("error: RPC failed; HTTP 520 curl 22"),
      ),
    ).toBe(true);
  });

  describe("isMissingCwdGitError", () => {
    test("returns true for missing cwd git error", () => {
      expect(
        isMissingCwdGitError(
          new Error(
            "fatal: Unable to read current working directory: No such file or directory",
          ),
        ),
      ).toBe(true);
    });

    test("returns false for non-cwd errors", () => {
      expect(
        isMissingCwdGitError(
          new Error("fatal: the remote end hung up unexpectedly"),
        ),
      ).toBe(false);
    });
  });

  test("returns true for RPC failed + remote hung up", () => {
    expect(
      isRetryableGitTransientError(
        new Error(
          "error: RPC failed; HTTP 520 curl 22 The requested URL returned error: 520\nfatal: the remote end hung up unexpectedly",
        ),
      ),
    ).toBe(true);
  });

  test("returns false for auth failures", () => {
    expect(
      isRetryableGitTransientError(
        new Error(
          "fatal: could not read Username for 'https://api.letta.com': Device not configured",
        ),
      ),
    ).toBe(false);
  });

  test("returns false for non-network git errors", () => {
    expect(
      isRetryableGitTransientError(
        new Error("fatal: Not possible to fast-forward, aborting."),
      ),
    ).toBe(false);
  });
});

describe("peer seed checkout", () => {
  const execFile = promisify(execFileCb);
  const remote = "https://api.example.com/v1/git/agent-test/state.git";
  const signedUrl = "https://sandbox.example.com/seed.bundle?token=private";

  test.each([
    { shallow: false, donorShallow: false, force: false },
    { shallow: false, donorShallow: false, force: true },
    { shallow: true, donorShallow: true, force: false },
    { shallow: true, donorShallow: true, force: true },
    { shallow: false, donorShallow: true, force: false },
  ])(
    "authoritative tip with $shallow depth, $donorShallow donor, force=$force",
    async (scenario) => {
      const root = await mkdtemp(join(tmpdir(), "memfs-seed-"));
      const oldSandbox = process.env.DAYTONA_SANDBOX_ID;
      process.env.DAYTONA_SANDBOX_ID = "sandbox-test";
      const origin = join(root, "origin");
      const donor = join(root, "donor");
      const target = join(root, "target");
      const bundle = join(root, "seed.bundle");
      const git = (cwd: string, args: string[]) =>
        execFile(
          "git",
          [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "-c",
            "commit.gpgsign=false",
            ...args,
          ],
          { cwd },
        );
      let fetchMock: ReturnType<typeof spyOn> | undefined;
      try {
        await mkdir(origin);
        await mkdir(target);
        await git(origin, ["init", "-b", "main"]);
        await writeFile(join(origin, "memory.txt"), "original");
        await git(origin, ["add", "."]);
        await git(origin, ["commit", "-m", "original"]);
        await git(origin, ["commit", "--allow-empty", "-m", "second"]);
        await git(root, [
          "clone",
          ...(scenario.donorShallow ? ["--depth", "1"] : []),
          pathToFileURL(origin).href,
          donor,
        ]);
        await git(donor, ["bundle", "create", bundle, "--remotes=origin"]);
        const shallow = scenario.donorShallow
          ? (await readFile(join(donor, ".git/shallow"), "utf8"))
              .trim()
              .split("\n")
          : [];
        if (scenario.force) {
          await git(origin, ["checkout", "--orphan", "rewritten"]);
        }
        await writeFile(join(origin, "memory.txt"), "authoritative");
        await git(origin, ["add", "."]);
        await git(origin, ["commit", "-m", "new tip"]);
        if (scenario.force) {
          await git(origin, ["branch", "-M", "main"]);
          await git(origin, ["branch", "-m", "release"]);
        }
        const bytes = await readFile(bundle);
        fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (
          input,
          init,
        ) => {
          if (String(input) === `${remote}/seed`) {
            expect(init?.method).toBe("POST");
            expect(init?.headers).toEqual({
              Authorization: "Bearer test-token",
              "X-Letta-Sandbox-Id": "sandbox-test",
            });
            expect(init?.redirect).toBe("error");
            return Response.json({ url: signedUrl, shallow });
          }
          expect(String(input)).toBe(signedUrl);
          expect(init?.headers).toBeUndefined();
          expect(init?.redirect).toBe("error");
          return new Response(bytes);
        }) as typeof fetch);
        const commands: string[][] = [];
        await withPeerSeed(async (cwd, args) => {
          commands.push(args);
          return git(cwd, [
            "-c",
            `url.${pathToFileURL(origin).href}.insteadOf=${remote}`,
            ...args,
          ]);
        })(
          target,
          ["clone", ...(scenario.shallow ? ["--depth", "1"] : []), remote, "."],
          "test-token",
          { timeoutMs: 5_000 },
        );
        expect(commands.some((args) => args[0] === "clone")).toBe(false);
        expect((await git(target, ["rev-parse", "HEAD"])).stdout).toBe(
          (await git(origin, ["rev-parse", "HEAD"])).stdout,
        );
        expect(await readFile(join(target, "memory.txt"), "utf8")).toBe(
          "authoritative",
        );
        expect(
          (await git(target, ["remote", "get-url", "origin"])).stdout.trim(),
        ).toBe(remote);
        expect(
          (
            await git(target, ["rev-parse", "--is-shallow-repository"])
          ).stdout.trim(),
        ).toBe(String(scenario.shallow));
        expect((await git(target, ["for-each-ref", "refs/seed/"])).stdout).toBe(
          "",
        );
        await git(target, ["fsck"]);
      } finally {
        fetchMock?.mockRestore();
        if (oldSandbox === undefined) delete process.env.DAYTONA_SANDBOX_ID;
        else process.env.DAYTONA_SANDBOX_ID = oldSandbox;
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.each([
    "outside",
    "occupied",
    "miss",
    "status",
    "network",
    "unsafe",
    "bad-bundle",
    "bad-json",
    "bad-shallow",
    "download-status",
    "stream-timeout",
    "partial",
  ])("fallback: %s", async (failure) => {
    const root = await mkdtemp(join(tmpdir(), "memfs-seed-fallback-"));
    const oldSandbox = process.env.DAYTONA_SANDBOX_ID;
    if (failure === "outside") delete process.env.DAYTONA_SANDBOX_ID;
    else process.env.DAYTONA_SANDBOX_ID = "sandbox-test";
    if (failure === "occupied")
      await writeFile(join(root, "keep"), "user data");
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (
      input,
    ) => {
      if (failure === "network") throw new Error("unavailable");
      if (String(input) === `${remote}/seed`) {
        if (failure === "status") return new Response("", { status: 503 });
        if (failure === "bad-json") return new Response("not json");
        return Response.json({
          url:
            failure === "miss"
              ? null
              : failure === "unsafe"
                ? "file:///tmp/seed"
                : signedUrl,
          shallow: failure === "bad-shallow" ? ["not-an-oid"] : [],
        });
      }
      if (failure === "download-status")
        return new Response("", { status: 403 });
      if (failure === "stream-timeout")
        return new Response(new ReadableStream());
      return new Response(
        failure === "bad-bundle"
          ? "[bundle]\nuri=file:///tmp/other"
          : "# v2 git bundle\ninvalid",
      );
    }) as typeof fetch);
    const commands: string[][] = [];
    try {
      await withPeerSeed(async (cwd, args) => {
        commands.push(args);
        if (args[0] === "init") {
          await writeFile(join(cwd, "partial"), "unpublished");
          throw new Error("git failed");
        }
        expect(await readdir(cwd)).toEqual(
          failure === "occupied" ? ["keep"] : [],
        );
        return { stdout: "" };
      })(root, ["clone", "--depth", "1", remote, "."], "test-token", {
        timeoutMs: 50,
      });
      expect(commands.at(-1)).toEqual(["clone", "--depth", "1", remote, "."]);
      expect(commands.length).toBe(failure === "partial" ? 2 : 1);
      if (["outside", "occupied"].includes(failure))
        expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
      if (oldSandbox === undefined) delete process.env.DAYTONA_SANDBOX_ID;
      else process.env.DAYTONA_SANDBOX_ID = oldSandbox;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("runGitWithRetry HTTP failures", () => {
  test.each([
    { status: 503, failures: 1, attempts: 2, succeeds: true },
    { status: 503, failures: 3, attempts: 3, succeeds: false },
    { status: 403, failures: 3, attempts: 1, succeeds: false },
  ])("clone: $status, $failures failures", async (scenario) => {
    const cwd = await mkdtemp(join(tmpdir(), "memfs-git-http-"));
    let attempts = 0;
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/repo.git/info/refs")) {
        attempts += 1;
        res.writeHead(attempts <= scenario.failures ? scenario.status : 200, {
          "Content-Type": "text/plain",
        });
        res.end();
      } else if (req.url === "/repo.git/HEAD") {
        res.end("ref: refs/heads/main\n");
      } else {
        res.writeHead(404).end();
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a TCP address");
      }
      const clone = runGitWithRetry(
        cwd,
        ["clone", `http://127.0.0.1:${address.port}/repo.git`, "."],
        undefined,
        { baseDelayMs: 0, timeoutMs: 5_000 },
      );
      if (scenario.succeeds) {
        await clone;
      } else {
        await expect(clone).rejects.toThrow(
          `The requested URL returned error: ${scenario.status}`,
        );
      }
      expect(attempts).toBe(scenario.attempts);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
