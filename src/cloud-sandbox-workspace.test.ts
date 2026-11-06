import { describe, expect, test } from "bun:test";
import type { AppServerClient } from "@/app-server-client";
import {
  sandboxRepositoryLayout,
  waitForSandboxRepositoryClones,
} from "./cloud-sandbox-workspace";

/** A listener whose `.git` listings come from `listing(path, poll)`. */
function listener(listing: (path: string, poll: number) => string[] | null) {
  const requests: Array<{ type: string; body: Record<string, unknown> }> = [];
  let polls = 0;
  const client = {
    request: async (type: string, body: Record<string, unknown>) => {
      requests.push({ type, body });
      const files = listing(String(body.path), polls);
      return files
        ? {
            type: "list_in_directory_response",
            path: body.path,
            folders: [],
            files,
            hasMore: false,
            success: true,
          }
        : {
            type: "list_in_directory_response",
            path: body.path,
            folders: [],
            hasMore: false,
            success: false,
            error: "ENOENT",
          };
    },
  } as unknown as Pick<AppServerClient, "request">;
  return {
    client,
    requests,
    nextPoll: () => {
      polls += 1;
    },
  };
}

const app = { owner: "owner", repo: "app" };
const lib = { owner: "owner", repo: "lib" };

describe("sandboxRepositoryLayout", () => {
  test("starts in the first repo and adds the others' skills", () => {
    expect(sandboxRepositoryLayout([app, lib])).toEqual({
      cwd: "/root/workspace/app",
      skillDirectories: ["/root/workspace/lib/.agents/skills"],
    });
    expect(sandboxRepositoryLayout([app])).toEqual({
      cwd: "/root/workspace/app",
      skillDirectories: [],
    });
    expect(sandboxRepositoryLayout([])).toEqual({ skillDirectories: [] });
  });
});

describe("waitForSandboxRepositoryClones", () => {
  test("polls until every repo has a checked-out index", async () => {
    let clock = 0;
    const wire = listener((path, poll) => {
      if (path === "/root/workspace/app/.git") return ["HEAD", "index"];
      // lib: missing, then mid-clone (.git without index), then done.
      if (poll === 0) return null;
      if (poll === 1) return ["HEAD", "config"];
      return ["HEAD", "config", "index"];
    });
    const result = await waitForSandboxRepositoryClones(
      wire.client,
      [app, lib],
      {
        timeoutMs: 60_000,
        pollIntervalMs: 1_000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
          wire.nextPoll();
        },
      },
    );
    expect(result).toEqual({});
    expect(wire.requests[0]).toEqual({
      type: "list_in_directory",
      body: { path: "/root/workspace/app/.git", include_files: true },
    });
    // app is done after the first poll and is not asked about again.
    expect(
      wire.requests.filter((r) => r.body.path === "/root/workspace/app/.git"),
    ).toHaveLength(1);
    expect(
      wire.requests.filter((r) => r.body.path === "/root/workspace/lib/.git"),
    ).toHaveLength(3);
  });

  test("gives up at the timeout with a warning naming the unfinished repos", async () => {
    let clock = 0;
    const wire = listener((path) =>
      path === "/root/workspace/app/.git" ? ["HEAD", "index"] : ["HEAD"],
    );
    const result = await waitForSandboxRepositoryClones(
      wire.client,
      [app, lib],
      {
        timeoutMs: 10_000,
        pollIntervalMs: 2_000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    );
    expect(result.warning).toContain("after 10s: /root/workspace/lib.");
    expect(result.warning).not.toContain("/root/workspace/app");
    expect(result.warning).toContain("started anyway");
  });

  test("treats a failed listing request as not cloned yet", async () => {
    let clock = 0;
    const client = {
      request: async () => {
        throw new Error("Timed out waiting for list_in_directory");
      },
    } as unknown as Pick<AppServerClient, "request">;
    const result = await waitForSandboxRepositoryClones(client, [app], {
      timeoutMs: 1_000,
      pollIntervalMs: 1_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(result.warning).toContain("/root/workspace/app");
  });

  test("stops waiting when the launch is cancelled", async () => {
    const controller = new AbortController();
    const wire = listener(() => ["HEAD"]);
    const waiting = waitForSandboxRepositoryClones(wire.client, [app], {
      signal: controller.signal,
      sleep: async () => {
        controller.abort(new Error("cancelled"));
      },
    });
    await expect(waiting).rejects.toThrow("cancelled");
  });
});
