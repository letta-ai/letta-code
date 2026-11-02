import { posix } from "node:path";
import type { AppServerClient } from "@/app-server-client";
import type { SandboxGithubRepository } from "@/backend/api/environments";
import type { ListInDirectoryResponseMessage } from "@/types/protocol_v2";

/** Where a Cloud sandbox clones requested repositories. */
export const SANDBOX_WORKSPACE_ROOT = "/root/workspace";

/** Default wait for requested repositories to finish cloning. */
export const SANDBOX_CLONE_TIMEOUT_MS = 4 * 60_000;

export function sandboxRepositoryPath(
  repository: Pick<SandboxGithubRepository, "repo">,
): string {
  return posix.join(SANDBOX_WORKSPACE_ROOT, repository.repo);
}

/**
 * Where a subagent on a sandbox with `repositories` starts. Its turn runs in
 * the first repository, so that repository's AGENTS.md, CLAUDE.md, and
 * `.agents/skills` load as they would in a local checkout. The other
 * repositories' `.agents/skills` become extra skill roots.
 */
export function sandboxRepositoryLayout(
  repositories: readonly SandboxGithubRepository[],
): { cwd?: string; skillDirectories: string[] } {
  const [first, ...rest] = repositories;
  if (!first) return { skillDirectories: [] };
  return {
    cwd: sandboxRepositoryPath(first),
    skillDirectories: rest.map((repository) =>
      posix.join(sandboxRepositoryPath(repository), ".agents", "skills"),
    ),
  };
}

type ListDirectoryClient = Pick<AppServerClient, "request">;

/**
 * A repository is cloned once `.git/index` exists: git creates `.git` as the
 * clone starts but writes the index only after the working tree is checked
 * out.
 */
async function isRepositoryCloned(
  client: ListDirectoryClient,
  repository: SandboxGithubRepository,
): Promise<boolean> {
  try {
    const response = await client.request<
      "list_in_directory",
      ListInDirectoryResponseMessage
    >(
      "list_in_directory",
      {
        path: posix.join(sandboxRepositoryPath(repository), ".git"),
        include_files: true,
      },
      {
        timeoutMs: 15_000,
        predicate: (message): message is ListInDirectoryResponseMessage =>
          message.type === "list_in_directory_response",
      },
    );
    return response.success && (response.files ?? []).includes("index");
  } catch {
    return false;
  }
}

/**
 * Poll the sandbox until every requested repository has finished cloning, or
 * the timeout passes. Returns a warning naming the repositories still cloning
 * on timeout; the caller continues the launch with it rather than failing.
 */
export async function waitForSandboxRepositoryClones(
  client: ListDirectoryClient,
  repositories: readonly SandboxGithubRepository[],
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    signal?: AbortSignal;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ warning?: string }> {
  const timeoutMs = options.timeoutMs ?? SANDBOX_CLONE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  let pending = [...repositories];
  while (pending.length > 0) {
    options.signal?.throwIfAborted();
    const cloned = await Promise.all(
      pending.map((repository) => isRepositoryCloned(client, repository)),
    );
    pending = pending.filter((_, index) => !cloned[index]);
    if (pending.length === 0 || now() >= deadline) break;
    await sleep(pollIntervalMs);
  }
  if (pending.length === 0) return {};
  const paths = pending.map(sandboxRepositoryPath).join(", ");
  return {
    warning: `Repository clone still in progress after ${Math.round(timeoutMs / 1000)}s: ${paths}. The subagent started anyway; files and skills from ${pending.length === 1 ? "that repository" : "those repositories"} may be missing until the clone finishes.`,
  };
}

/** The clone warning as an automated note in the subagent's first message. */
export function sandboxCloneWarningReminder(warning: string): string {
  return `<system-reminder>\n${warning}\n</system-reminder>`;
}
