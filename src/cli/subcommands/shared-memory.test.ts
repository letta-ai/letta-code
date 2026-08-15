import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getRepositoryMountDir } from "@/agent/memory-git";
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
    const recompileAgent = mock(async () => {});
    const code = await runSharedMemorySubcommand(
      ["attach", "agent-forum", "--agent", MOUNT_AGENT_ID],
      {
        initializeSettings: async () => {},
        request: request as never,
        syncRepositories: syncRepositories as never,
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
    const code = await runSharedMemorySubcommand(
      ["attach", "agent-forum", "--agent", MOUNT_AGENT_ID],
      {
        initializeSettings: async () => {},
        request: request as never,
        syncRepositories: syncRepositories as never,
        recompileAgent: async () => {},
      },
    );
    expect(code).toBe(1);
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

  test("detach deletes the link and recompiles", async () => {
    const { request, calls } = makeRequest();
    const recompileAgent = mock(async () => {});
    const code = await runSharedMemorySubcommand(
      ["detach", "repo-2", "--agent", "agent-xyz"],
      {
        initializeSettings: async () => {},
        request: request as never,
        recompileAgent,
      },
    );
    expect(code).toBe(0);
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
