import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getRepositoryMountDir } from "@/agent/memory-git";
import { ApiRequestError } from "@/backend/api/request";
import {
  resolveRepositoryReference,
  resolveSharedMemoryAgentId,
  runSharedMemorySubcommand,
} from "@/cli/subcommands/shared-memory";

const REPOSITORIES = [
  { id: "repo-1", name: "shared-notes" },
  { id: "repo-2", name: "agent-forum" },
];

/** Agent id used by tests that touch the real mount path under ~/.letta. */
const MOUNT_AGENT_ID = "agent-shared-memory-subcommand-test";

function createMountFor(repositoryName: string): string {
  const mountDir = getRepositoryMountDir(MOUNT_AGENT_ID, repositoryName);
  mkdirSync(join(mountDir, ".git"), { recursive: true });
  return mountDir;
}

function makeRequest(
  overrides: Partial<
    Record<string, (method: string, path: string, body?: unknown) => unknown>
  > = {},
) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const request = mock(
    async (method: string, path: string, body?: Record<string, unknown>) => {
      calls.push({ method, path, body });
      if (method === "GET" && path.startsWith("/v1/repositories?")) {
        return { repositories: REPOSITORIES, has_next_page: false };
      }
      if (method === "GET" && /^\/v1\/repositories\/[^/]+$/.test(path)) {
        const repositoryId = decodeURIComponent(
          path.slice("/v1/repositories/".length),
        );
        const repository = REPOSITORIES.find(({ id }) => id === repositoryId);
        if (repository) return repository;
        throw new Error(`Repository not found: ${repositoryId}`);
      }
      if (method === "GET" && /\/v1\/agents\/.*\/repositories$/.test(path)) {
        const handler = overrides.listAgentRepositories;
        if (handler) return handler(method, path, body);
        return {
          repositories: [
            { id: "repo-2", name: "agent-forum", is_primary: false },
          ],
        };
      }
      if (method === "POST" && /\/v1\/agents\/.*\/repositories$/.test(path)) {
        return { success: true };
      }
      if (method === "DELETE") {
        return { success: true };
      }
      if (method === "GET" && path.includes("/versions")) {
        return { commits: [{ sha: "abc", message: "init" }] };
      }
      if (method === "POST" && path === "/v1/repositories") {
        return { id: "repo-new", name: (body as { name: string }).name };
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  );
  return { request, calls };
}

describe("resolveSharedMemoryAgentId", () => {
  test("prefers --agent, then --agent-id, then env", () => {
    expect(
      resolveSharedMemoryAgentId("agent-a", "agent-b", {
        LETTA_AGENT_ID: "agent-c",
      }),
    ).toBe("agent-a");
    expect(
      resolveSharedMemoryAgentId(undefined, "agent-b", {
        LETTA_AGENT_ID: "agent-c",
      }),
    ).toBe("agent-b");
    expect(
      resolveSharedMemoryAgentId(undefined, undefined, {
        LETTA_AGENT_ID: "agent-c",
      }),
    ).toBe("agent-c");
    expect(
      resolveSharedMemoryAgentId(undefined, undefined, {
        AGENT_ID: "agent-d",
      }),
    ).toBe("agent-d");
    expect(resolveSharedMemoryAgentId(undefined, undefined, {})).toBe("");
  });
});

describe("resolveRepositoryReference", () => {
  test("matches by id first, then by name", () => {
    expect(resolveRepositoryReference(REPOSITORIES, "repo-1")?.name).toBe(
      "shared-notes",
    );
    expect(resolveRepositoryReference(REPOSITORIES, "agent-forum")?.id).toBe(
      "repo-2",
    );
    expect(resolveRepositoryReference(REPOSITORIES, "missing")).toBeNull();
    expect(resolveRepositoryReference(REPOSITORIES, "  ")).toBeNull();
  });
});

describe("runSharedMemorySubcommand", () => {
  const envKeys = ["LETTA_AGENT_ID", "AGENT_ID"] as const;
  const savedEnv: Record<string, string | undefined> = {};
  let logs: string[] = [];
  let errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    logs = [];
    errors = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    console.error = (...args: unknown[]) => {
      errors.push(args.join(" "));
    };
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    console.log = originalLog;
    console.error = originalError;
    for (const repository of REPOSITORIES) {
      rmSync(getRepositoryMountDir(MOUNT_AGENT_ID, repository.name), {
        recursive: true,
        force: true,
      });
    }
  });

  test("help prints usage and succeeds", async () => {
    const code = await runSharedMemorySubcommand(["help"]);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("letta shared-memory attach");
  });

  test("list marks attached repositories for the env agent", async () => {
    process.env.LETTA_AGENT_ID = "agent-xyz";
    const { request } = makeRequest();
    const code = await runSharedMemorySubcommand(["list"], {
      initializeSettings: async () => {},
      request: request as never,
    });
    expect(code).toBe(0);
    const output = JSON.parse(logs.join("\n"));
    expect(output.repositories).toEqual([
      { id: "repo-1", name: "shared-notes", attached: false },
      { id: "repo-2", name: "agent-forum", attached: true },
    ]);
  });

  test("create requires --name", async () => {
    const { request } = makeRequest();
    const code = await runSharedMemorySubcommand(["create"], {
      initializeSettings: async () => {},
      request: request as never,
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("--name");
  });

  test("create posts to /v1/repositories", async () => {
    const { request, calls } = makeRequest();
    const code = await runSharedMemorySubcommand(
      ["create", "--name", "shared-notes"],
      {
        initializeSettings: async () => {},
        request: request as never,
      },
    );
    expect(code).toBe(0);
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/v1/repositories",
        body: { name: "shared-notes" },
      },
    ]);
    expect(JSON.parse(logs.join("\n"))).toEqual({
      id: "repo-new",
      name: "shared-notes",
    });
  });

  test("attach resolves by name, polls, syncs mounts, and recompiles", async () => {
    const { request, calls } = makeRequest();
    const mountDir = createMountFor("agent-forum");
    const syncRepositories = mock(async () => ({
      mounted: 1,
      skipped: 0,
      failed: 0,
      summaries: [`agent-forum: ${mountDir}`],
    }));
    const invalidateClientSkills = mock((agentId: string) => {
      expect(agentId).toBe(MOUNT_AGENT_ID);
      expect(syncRepositories).toHaveBeenCalledWith(MOUNT_AGENT_ID);
      expect(existsSync(join(mountDir, ".git"))).toBe(true);
    });
    const recompileAgent = mock(async () => {});
    const code = await runSharedMemorySubcommand(
      ["attach", "agent-forum", "--agent", MOUNT_AGENT_ID],
      {
        initializeSettings: async () => {},
        request: request as never,
        syncRepositories: syncRepositories as never,
        invalidateClientSkills,
        recompileAgent,
      },
    );
    expect(code).toBe(0);
    expect(
      calls.some(
        (call) =>
          call.method === "POST" &&
          call.path === `/v1/agents/${MOUNT_AGENT_ID}/repositories` &&
          (call.body as { repository_id: string }).repository_id === "repo-2",
      ),
    ).toBe(true);
    expect(syncRepositories).toHaveBeenCalledWith(MOUNT_AGENT_ID);
    expect(invalidateClientSkills).toHaveBeenCalledTimes(1);
    expect(recompileAgent).toHaveBeenCalledWith(MOUNT_AGENT_ID);
    const output = JSON.parse(logs.join("\n"));
    expect(output.attached).toBe(true);
    expect(output.repository).toEqual({ id: "repo-2", name: "agent-forum" });
    expect(output.mount).toBe(mountDir);
    expect(output.recompile_failed).toBeUndefined();
  });

  test("attach fails when the mount was not created", async () => {
    const { request } = makeRequest();
    // No mount on disk: sync claims success but the checkout is not there.
    const syncRepositories = mock(async () => ({
      mounted: 0,
      skipped: 0,
      failed: 1,
      summaries: ["agent-forum: failed: network"],
    }));
    const invalidateClientSkills = mock((agentId: string) => {
      expect(agentId).toBe(MOUNT_AGENT_ID);
      expect(syncRepositories).toHaveBeenCalledWith(MOUNT_AGENT_ID);
    });
    const code = await runSharedMemorySubcommand(
      ["attach", "agent-forum", "--agent", MOUNT_AGENT_ID],
      {
        initializeSettings: async () => {},
        request: request as never,
        syncRepositories: syncRepositories as never,
        invalidateClientSkills,
        recompileAgent: async () => {},
      },
    );
    expect(code).toBe(1);
    // The server attachment exists even when its local checkout failed, so the
    // old attachment-list snapshot must still be cleared.
    expect(invalidateClientSkills).toHaveBeenCalledTimes(1);
    const output = JSON.parse(logs.join("\n"));
    expect(output.mount).toBeNull();
    expect(output.sync).toEqual(["agent-forum: failed: network"]);
    expect(output.note).toContain("letta shared-memory sync");
  });

  test("attach reports a failed recompile instead of hiding it", async () => {
    const { request } = makeRequest();
    const mountDir = createMountFor("agent-forum");
    const syncRepositories = mock(async () => ({
      mounted: 1,
      skipped: 0,
      failed: 0,
      summaries: [`agent-forum: ${mountDir}`],
    }));
    const code = await runSharedMemorySubcommand(
      ["attach", "agent-forum", "--agent", MOUNT_AGENT_ID],
      {
        initializeSettings: async () => {},
        request: request as never,
        syncRepositories: syncRepositories as never,
        recompileAgent: async () => {
          throw new Error("recompile boom");
        },
      },
    );
    // The attach itself succeeded, so this stays a success exit.
    expect(code).toBe(0);
    expect(JSON.parse(logs.join("\n")).recompile_failed).toBe("recompile boom");
  });

  test("attach fails cleanly when the repository never becomes visible", async () => {
    const { request } = makeRequest({
      listAgentRepositories: () => ({ repositories: [] }),
    });
    const syncRepositories = mock(async () => ({
      mounted: 0,
      skipped: 0,
      failed: 0,
      summaries: [],
    }));
    const code = await runSharedMemorySubcommand(
      ["attach", "shared-notes", "--agent", "agent-xyz"],
      {
        initializeSettings: async () => {},
        request: request as never,
        syncRepositories: syncRepositories as never,
        recompileAgent: async () => {},
        attachPoll: { intervalMs: 1, attempts: 3 },
      },
    );
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("did not appear");
    expect(syncRepositories).not.toHaveBeenCalled();
  });

  test("attach requires an agent id", async () => {
    const { request } = makeRequest();
    const code = await runSharedMemorySubcommand(["attach", "agent-forum"], {
      initializeSettings: async () => {},
      request: request as never,
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("Agent id required");
  });

  test("repository ids use point lookup without listing or pagination", async () => {
    const { request, calls } = makeRequest();
    const code = await runSharedMemorySubcommand(
      ["detach", "repo-2", "--agent", "agent-xyz"],
      {
        initializeSettings: async () => {},
        request: request as never,
        recompileAgent: async () => {},
      },
    );

    expect(code).toBe(0);
    expect(calls[0]).toEqual({
      method: "GET",
      path: "/v1/repositories/repo-2",
      body: undefined,
    });
    expect(
      calls.some(
        ({ method, path }) =>
          method === "GET" && path.startsWith("/v1/repositories?"),
      ),
    ).toBe(false);
  });

  test("missing repository ids retain not-found guidance after name fallback", async () => {
    const request = mock(async (method: string, path: string) => {
      if (path === "/v1/repositories/repo-missing") {
        throw new ApiRequestError(
          "API error (404): not found",
          404,
          "not found",
        );
      }
      if (method === "GET" && path === "/v1/repositories?limit=50&offset=0") {
        return { repositories: [], has_next_page: false };
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    const code = await runSharedMemorySubcommand(["history", "repo-missing"], {
      initializeSettings: async () => {},
      request: request as never,
    });

    expect(code).toBe(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(errors.join("\n")).toContain("Repository not found: repo-missing");
  });

  test("point lookup 404 falls back to an exact repo-prefixed name", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const request = mock(async (method: string, path: string) => {
      calls.push({ method, path });
      if (path === "/v1/repositories/repo-shared-notes") {
        throw new ApiRequestError(
          "API error (404): not found",
          404,
          "not found",
        );
      }
      if (path === "/v1/repositories?limit=50&offset=0") {
        return {
          repositories: [
            { id: "repository-decoy", name: "repo-shared-notes-copy" },
          ],
          has_next_page: true,
        };
      }
      if (path === "/v1/repositories?limit=50&offset=50") {
        return {
          repositories: [{ id: "repository-exact", name: "repo-shared-notes" }],
          has_next_page: false,
        };
      }
      if (path === "/v1/repositories/repository-exact/versions?limit=20") {
        return { commits: [] };
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    const code = await runSharedMemorySubcommand(
      ["history", "repo-shared-notes"],
      {
        initializeSettings: async () => {},
        request: request as never,
      },
    );

    expect(code).toBe(0);
    expect(calls.slice(0, 3)).toEqual([
      { method: "GET", path: "/v1/repositories/repo-shared-notes" },
      { method: "GET", path: "/v1/repositories?limit=50&offset=0" },
      { method: "GET", path: "/v1/repositories?limit=50&offset=50" },
    ]);
    expect(JSON.parse(logs.join("\n")).repository).toBe("repo-shared-notes");
  });

  test("non-404 point lookup failures do not fall back to listing", async () => {
    const request = mock(async () => {
      throw new ApiRequestError("API error (403): forbidden", 403, "forbidden");
    });

    const code = await runSharedMemorySubcommand(["history", "repo-private"], {
      initializeSettings: async () => {},
      request: request as never,
    });

    expect(code).toBe(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(errors.join("\n")).toContain("API error (403): forbidden");
  });

  test("repository names remain exact across all repository pages", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const request = mock(async (method: string, path: string) => {
      calls.push({ method, path });
      if (method === "GET" && path === "/v1/repositories?limit=50&offset=0") {
        return {
          repositories: [{ id: "repo-decoy", name: "shared-notes-copy" }],
          has_next_page: true,
        };
      }
      if (method === "GET" && path === "/v1/repositories?limit=50&offset=50") {
        return {
          repositories: [{ id: "repo-exact", name: "shared-notes" }],
          has_next_page: false,
        };
      }
      if (
        method === "GET" &&
        path === "/v1/repositories/repo-exact/versions?limit=20"
      ) {
        return { commits: [] };
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    const code = await runSharedMemorySubcommand(["history", "shared-notes"], {
      initializeSettings: async () => {},
      request: request as never,
    });

    expect(code).toBe(0);
    expect(calls.slice(0, 2)).toEqual([
      { method: "GET", path: "/v1/repositories?limit=50&offset=0" },
      { method: "GET", path: "/v1/repositories?limit=50&offset=50" },
    ]);
    expect(JSON.parse(logs.join("\n")).repository).toBe("shared-notes");
  });

  test("detach deletes the link and recompiles", async () => {
    const { request, calls } = makeRequest();
    const invalidateClientSkills = mock((agentId: string) => {
      expect(agentId).toBe("agent-xyz");
      expect(
        calls.some(
          (call) =>
            call.method === "DELETE" &&
            call.path === "/v1/agents/agent-xyz/repositories/repo-2",
        ),
      ).toBe(true);
    });
    const recompileAgent = mock(async () => {});
    const code = await runSharedMemorySubcommand(
      ["detach", "repo-2", "--agent", "agent-xyz"],
      {
        initializeSettings: async () => {},
        request: request as never,
        invalidateClientSkills,
        recompileAgent,
      },
    );
    expect(code).toBe(0);
    expect(invalidateClientSkills).toHaveBeenCalledTimes(1);
    expect(
      calls.some(
        (call) =>
          call.method === "DELETE" &&
          call.path === "/v1/agents/agent-xyz/repositories/repo-2",
      ),
    ).toBe(true);
    expect(recompileAgent).toHaveBeenCalledWith("agent-xyz");
    expect(JSON.parse(logs.join("\n")).detached).toBe(true);
  });

  test("detach reports a failed recompile instead of hiding it", async () => {
    const { request } = makeRequest();
    const code = await runSharedMemorySubcommand(
      ["detach", "repo-2", "--agent", "agent-xyz"],
      {
        initializeSettings: async () => {},
        request: request as never,
        recompileAgent: async () => {
          throw new Error("recompile boom");
        },
      },
    );
    // The detach itself succeeded, so this stays a success exit.
    expect(code).toBe(0);
    const output = JSON.parse(logs.join("\n"));
    expect(output.detached).toBe(true);
    expect(output.recompile_failed).toBe("recompile boom");
  });

  test("sync reports the underlying result and fails on failures", async () => {
    const syncRepositories = mock(async () => ({
      mounted: 0,
      skipped: 0,
      failed: 1,
      summaries: ["agent-forum: failed: network"],
    }));
    const code = await runSharedMemorySubcommand(
      ["sync", "--agent", "agent-xyz"],
      {
        initializeSettings: async () => {},
        syncRepositories: syncRepositories as never,
      },
    );
    expect(code).toBe(1);
    expect(JSON.parse(logs.join("\n")).failed).toBe(1);
  });

  test("history scopes to a path and repository", async () => {
    const { request, calls } = makeRequest();
    const code = await runSharedMemorySubcommand(
      ["history", "shared-notes", "--path", "docs/plan.md", "--limit", "5"],
      {
        initializeSettings: async () => {},
        request: request as never,
      },
    );
    expect(code).toBe(0);
    const versionsCall = calls.find((call) => call.path.includes("/versions"));
    expect(versionsCall?.path).toContain("/v1/repositories/repo-1/versions");
    expect(versionsCall?.path).toContain("limit=5");
    expect(versionsCall?.path).toContain("path=docs%2Fplan.md");
    const output = JSON.parse(logs.join("\n"));
    expect(output.repository).toBe("shared-notes");
    expect(output.commits).toHaveLength(1);
  });

  test("unknown action fails with usage", async () => {
    const code = await runSharedMemorySubcommand(["frobnicate"], {
      initializeSettings: async () => {},
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("Unknown action");
  });

  test("unknown repository reference fails with guidance", async () => {
    const { request } = makeRequest();
    const code = await runSharedMemorySubcommand(
      ["attach", "nope", "--agent", "agent-xyz"],
      {
        initializeSettings: async () => {},
        request: request as never,
      },
    );
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("Repository not found");
  });
});
