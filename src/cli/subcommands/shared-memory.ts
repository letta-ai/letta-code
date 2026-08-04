import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isLocalAgentId } from "@/agent/agent-id";
import {
  getRepositoryMountDir,
  syncAttachedAgentRepositories,
} from "@/agent/memory-git";
import { apiRequest } from "@/backend/api/request";
import { isLocalBackendEnvEnabled } from "@/backend/local/paths";
import { settingsManager } from "@/settings-manager";

/**
 * `letta shared-memory` — management plane for shared memory repositories.
 *
 * Shared memory repositories are org-owned git repos served over the same
 * smart-HTTP transport as agent MemFS (`/v1/git/<agent>/repositories/<name>.git`).
 * The DATA plane is the local mount at `$MEMORY_DIR/../<name>`: read, edit,
 * commit, and push there with plain git, exactly like MemFS. This subcommand
 * only covers the operations that genuinely need the API — create/list/
 * attach/detach/history — plus `sync`, which materializes local mounts.
 *
 * Uses harness auth (OAuth keychain token or API key), so it works in
 * environments where `LETTA_API_KEY` is not exported in the shell.
 */

interface RepositorySummary {
  id: string;
  name: string;
  created_at?: string;
  updated_at?: string;
}

interface AgentRepositorySummary {
  id: string;
  name: string;
  is_primary: boolean;
}

type SharedMemorySubcommandDeps = {
  initializeSettings?: () => Promise<void>;
  request?: typeof apiRequest;
  syncRepositories?: typeof syncAttachedAgentRepositories;
  recompileAgent?: (agentId: string) => Promise<void>;
  attachPoll?: { intervalMs: number; attempts: number };
};

function printUsage(): void {
  console.log(
    `
Usage:
  letta shared-memory list [--agent <id>]
  letta shared-memory create --name <name>
  letta shared-memory attach <name-or-id> [--agent <id>]
  letta shared-memory detach <name-or-id> [--agent <id>]
  letta shared-memory sync [--agent <id>]
  letta shared-memory history <name-or-id> [--path <file>] [--limit <n>]

Actions:
  list      List org repositories, marking which are attached to the agent
  create    Create a new shared memory repository
  attach    Attach a repository to the agent, clone its local mount, and
            recompile the agent's system prompt
  detach    Detach a repository from the agent and recompile
  sync      Clone/pull local mounts for every repository attached to the agent
  history   List commits for a repository (optionally scoped to one path)

Notes:
  - Output is JSON only.
  - Agent id comes from --agent or AGENT_ID/LETTA_AGENT_ID in the env.
  - Uses CLI auth; override with LETTA_API_KEY/LETTA_BASE_URL if needed.
  - Attached repositories mount at $MEMORY_DIR/../<name> as normal git
    checkouts. Edit files and commit/push there like MemFS — no API calls
    are needed for file content.

Examples:
  letta shared-memory list
  letta shared-memory create --name shared-notes
  letta shared-memory attach shared-notes
  letta shared-memory history shared-notes --path docs/plan.md
`.trim(),
  );
}

const SHARED_MEMORY_OPTIONS = {
  help: { type: "boolean", short: "h" },
  agent: { type: "string" },
  "agent-id": { type: "string" },
  name: { type: "string" },
  path: { type: "string" },
  limit: { type: "string" },
} as const;

function parseSharedMemoryArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: SHARED_MEMORY_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

export function resolveSharedMemoryAgentId(
  agent?: string,
  agentId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (agent || agentId || env.LETTA_AGENT_ID || env.AGENT_ID || "").trim();
}

function parseLimit(value: unknown, fallback: number): number {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

async function listOrgRepositories(
  request: typeof apiRequest,
): Promise<RepositorySummary[]> {
  const repositories: RepositorySummary[] = [];
  const limit = 50;
  let offset = 0;
  for (;;) {
    const page = await request<{
      repositories: RepositorySummary[];
      has_next_page: boolean;
    }>("GET", `/v1/repositories?limit=${limit}&offset=${offset}`);
    repositories.push(...page.repositories);
    if (!page.has_next_page) break;
    offset += limit;
  }
  return repositories;
}

async function listAgentRepositories(
  request: typeof apiRequest,
  agentId: string,
): Promise<AgentRepositorySummary[]> {
  const response = await request<{
    repositories: AgentRepositorySummary[];
  }>("GET", `/v1/agents/${encodeURIComponent(agentId)}/repositories`);
  return response.repositories.filter(
    (repository) => !repository.is_primary && repository.name !== "memory",
  );
}

/**
 * Resolve a user-supplied name or repository id against the org's
 * repositories. Ids (`repo-...`) match on id; anything else matches on name.
 */
export function resolveRepositoryReference(
  repositories: RepositorySummary[],
  reference: string,
): RepositorySummary | null {
  const trimmed = reference.trim();
  if (!trimmed) return null;
  return (
    repositories.find((repository) => repository.id === trimmed) ??
    repositories.find((repository) => repository.name === trimmed) ??
    null
  );
}

const DEFAULT_ATTACH_POLL = { intervalMs: 1_000, attempts: 15 };

async function waitForAttachedRepository(
  request: typeof apiRequest,
  agentId: string,
  repositoryId: string,
  poll: { intervalMs: number; attempts: number },
): Promise<boolean> {
  for (let attempt = 0; attempt < poll.attempts; attempt += 1) {
    const attached = await listAgentRepositories(request, agentId);
    if (attached.some((repository) => repository.id === repositoryId)) {
      return true;
    }
    await new Promise((resolvePoll) =>
      setTimeout(resolvePoll, poll.intervalMs),
    );
  }
  return false;
}

async function defaultRecompileAgent(agentId: string): Promise<void> {
  const { getClient } = await import("@/backend/api/client");
  const client = await getClient();
  await client.agents.recompile(agentId, { update_timestamp: false });
}

/**
 * Recompile, returning the failure message instead of throwing.
 *
 * A failed recompile does not undo the attach/detach, so it must not fail the
 * command — but it does mean the system prompt projection disagrees with disk
 * until the next natural recompile, which the caller reports rather than hides.
 */
async function recompileAndReportFailure(
  recompileAgent: (agentId: string) => Promise<void>,
  agentId: string,
): Promise<string | null> {
  try {
    await recompileAgent(agentId);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function requireAgentId(parsed: {
  values: { agent?: string; "agent-id"?: string };
}): string | null {
  const agentId = resolveSharedMemoryAgentId(
    parsed.values.agent,
    parsed.values["agent-id"],
  );
  if (!agentId) {
    console.error(
      "Agent id required: pass --agent <id> or set AGENT_ID/LETTA_AGENT_ID.",
    );
    return null;
  }
  return agentId;
}

export async function runSharedMemorySubcommand(
  argv: string[],
  deps: SharedMemorySubcommandDeps = {},
): Promise<number> {
  let parsed: ReturnType<typeof parseSharedMemoryArgs>;
  try {
    parsed = parseSharedMemoryArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printUsage();
    return 1;
  }

  const [action, reference] = parsed.positionals;
  if (parsed.values.help || !action || action === "help") {
    printUsage();
    return 0;
  }

  if (isLocalBackendEnvEnabled()) {
    console.error(
      "Shared memory requires a Letta Cloud agent; the local backend does not support it.",
    );
    return 1;
  }

  await (deps.initializeSettings ?? (() => settingsManager.initialize()))();
  const request = deps.request ?? apiRequest;
  const syncRepositories =
    deps.syncRepositories ?? syncAttachedAgentRepositories;
  const recompileAgent = deps.recompileAgent ?? defaultRecompileAgent;

  try {
    if (action === "list") {
      const agentId = resolveSharedMemoryAgentId(
        parsed.values.agent,
        parsed.values["agent-id"],
      );
      const repositories = await listOrgRepositories(request);
      let attachedIds = new Set<string>();
      if (agentId && !isLocalAgentId(agentId)) {
        const attached = await listAgentRepositories(request, agentId);
        attachedIds = new Set(attached.map((repository) => repository.id));
      }
      console.log(
        JSON.stringify(
          {
            repositories: repositories.map((repository) => ({
              ...repository,
              ...(agentId ? { attached: attachedIds.has(repository.id) } : {}),
            })),
          },
          null,
          2,
        ),
      );
      return 0;
    }

    if (action === "create") {
      const name = parsed.values.name?.trim();
      if (!name) {
        console.error("Usage: letta shared-memory create --name <name>");
        return 1;
      }
      const repository = await request<RepositorySummary>(
        "POST",
        "/v1/repositories",
        { name },
      );
      console.log(JSON.stringify(repository, null, 2));
      return 0;
    }

    if (action === "attach" || action === "detach" || action === "history") {
      if (!reference) {
        console.error(`Usage: letta shared-memory ${action} <name-or-id>`);
        return 1;
      }
      const repositories = await listOrgRepositories(request);
      const repository = resolveRepositoryReference(repositories, reference);
      if (!repository) {
        console.error(
          `Repository not found: ${reference}. Run \`letta shared-memory list\` to see available repositories.`,
        );
        return 1;
      }

      if (action === "history") {
        const limit = parseLimit(parsed.values.limit, 20);
        const query = new URLSearchParams({ limit: String(limit) });
        if (parsed.values.path) {
          query.set("path", parsed.values.path);
        }
        const versions = await request<{ commits: unknown[] }>(
          "GET",
          `/v1/repositories/${encodeURIComponent(repository.id)}/versions?${query}`,
        );
        console.log(
          JSON.stringify({ repository: repository.name, ...versions }, null, 2),
        );
        return 0;
      }

      const agentId = requireAgentId(parsed);
      if (!agentId) return 1;

      if (action === "attach") {
        await request(
          "POST",
          `/v1/agents/${encodeURIComponent(agentId)}/repositories`,
          { repository_id: repository.id },
        );
        const visible = await waitForAttachedRepository(
          request,
          agentId,
          repository.id,
          deps.attachPoll ?? DEFAULT_ATTACH_POLL,
        );
        if (!visible) {
          console.error(
            `Attach accepted but ${repository.name} did not appear in the agent's repository list. Retry \`letta shared-memory sync\` shortly.`,
          );
          return 1;
        }
        const sync = await syncRepositories(agentId);
        const recompileError = await recompileAndReportFailure(
          recompileAgent,
          agentId,
        );
        const mountDir = getRepositoryMountDir(agentId, repository.name);
        const mounted = existsSync(join(mountDir, ".git"));
        console.log(
          JSON.stringify(
            {
              attached: true,
              repository: { id: repository.id, name: repository.name },
              mount: mounted ? mountDir : null,
              sync: sync.summaries,
              ...(recompileError ? { recompile_failed: recompileError } : {}),
              note: mounted
                ? "Edit files under the mount and commit/push with git, like MemFS."
                : "The repository is attached but its local mount was not created — see `sync` above. Resolve the reported error, then re-run `letta shared-memory sync`.",
            },
            null,
            2,
          ),
        );
        // The attach itself succeeded; a stale projection self-heals on the
        // next recompile. A missing mount does not: it breaks the documented
        // git workflow, so it must not be reported as success.
        return mounted ? 0 : 1;
      }

      // detach
      await request(
        "DELETE",
        `/v1/agents/${encodeURIComponent(agentId)}/repositories/${encodeURIComponent(repository.id)}`,
      );
      const detachRecompileError = await recompileAndReportFailure(
        recompileAgent,
        agentId,
      );
      console.log(
        JSON.stringify(
          {
            detached: true,
            repository: { id: repository.id, name: repository.name },
            ...(detachRecompileError
              ? { recompile_failed: detachRecompileError }
              : {}),
            note: "The local mount was left in place; delete it manually if no longer needed.",
          },
          null,
          2,
        ),
      );
      return 0;
    }

    if (action === "sync") {
      const agentId = requireAgentId(parsed);
      if (!agentId) return 1;
      const result = await syncRepositories(agentId);
      console.log(JSON.stringify(result, null, 2));
      return result.failed > 0 ? 1 : 0;
    }

    console.error(`Unknown action: ${action}`);
    printUsage();
    return 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
