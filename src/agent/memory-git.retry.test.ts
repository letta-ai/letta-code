import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildGitTransferStallArgs } from "@/agent/git-transfer-config";
import {
  isMissingCwdGitError,
  isRetryableGitTransientError,
  runGit,
  runGitWithRetry,
} from "@/agent/memory-git";

test("clones include HTTP transfer stall detection", () => {
  expect(
    buildGitTransferStallArgs(["clone", "https://example.com/repo.git"]),
  ).toEqual(["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60"]);
});

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

describe("runGit HTTP timeout cleanup", () => {
  test("reaps the HTTP helper before rejecting a timed-out clone", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "memfs-git-timeout-"));
    let requests = 0;
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer(() => {
      requests += 1;
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Expected TCP address");
      const clone = runGit(
        cwd,
        ["clone", `http://127.0.0.1:${address.port}/repo.git`, "."],
        undefined,
        { timeoutMs: 2000 },
      );
      await expect(clone).rejects.toThrow();
      expect(requests).toBeGreaterThan(0);
      // Observe FIN/close from the real git-remote-http process, without
      // forcibly closing server sockets to hide an orphaned helper.
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(
          () =>
            reject(new Error("git HTTP helper still connected after timeout")),
          1000,
        );
        Promise.all(
          [...sockets].map(
            (socket) =>
              new Promise<void>((closed) => socket.once("close", closed)),
          ),
        ).then(() => {
          clearTimeout(deadline);
          resolve();
        });
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
