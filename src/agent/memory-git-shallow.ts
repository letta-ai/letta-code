import { debugLog, debugWarn } from "@/utils/debug";

/**
 * Depth for the agent's primary memory clone, set by the sandbox provisioner.
 *
 * Slack v2 sandboxes are small, short-lived, and have to stay responsive to
 * Slack. Their agents never read memory history on the boot path — memory
 * blocks are compiled server-side — so paying for the full commit log of a
 * long-lived memory repo on every cold sandbox is wasted time and disk.
 * letta-cloud sets this to `1` for those sandboxes only; every other runtime
 * leaves it unset and keeps cloning the whole history.
 *
 * An agent that genuinely needs history can still run `git fetch --deepen=<n>`
 * or `git fetch --unshallow`, which the memfs system prompt already documents.
 */
export const MEMORY_CLONE_DEPTH_ENV = "LETTA_MEMORY_CLONE_DEPTH";

/** Run git in a directory. Injected so this module stays off memory-git's cycle. */
export type MemoryGitRunner = (
  cwd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Parsed clone depth, or undefined for a full clone.
 *
 * Anything that is not a positive integer is ignored rather than fatal: a
 * malformed value from a sandbox template must not make memory unavailable.
 */
export function resolveMemoryCloneDepth(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env[MEMORY_CLONE_DEPTH_ENV]?.trim();
  if (!raw) return undefined;
  const depth = Number(raw);
  if (!Number.isSafeInteger(depth) || depth <= 0) {
    debugWarn(
      "memfs-git",
      `Ignoring invalid ${MEMORY_CLONE_DEPTH_ENV}=${raw}; cloning full history`,
    );
    return undefined;
  }
  return depth;
}

/**
 * Argv for cloning the memory repo into the current directory.
 *
 * `--depth` implies `--single-branch`, which matches how memory is used: sync
 * only ever fast-forwards, rebases, or pushes `main`.
 */
export function buildMemoryCloneArgs(
  remoteUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const depth = resolveMemoryCloneDepth(env);
  if (depth === undefined) return ["clone", remoteUrl, "."];
  debugLog("memfs-git", `Cloning memory repo at depth ${depth}`);
  return ["clone", "--depth", String(depth), remoteUrl, "."];
}

export async function isShallowMemoryRepo(
  memoryDir: string,
  runGit: MemoryGitRunner,
): Promise<boolean> {
  try {
    const { stdout } = await runGit(memoryDir, [
      "rev-parse",
      "--is-shallow-repository",
    ]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function hasMergeBaseWithUpstream(
  memoryDir: string,
  runGit: MemoryGitRunner,
): Promise<boolean> {
  try {
    await runGit(memoryDir, ["merge-base", "HEAD", "@{u}"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether local history still connects to the upstream branch.
 *
 * A missing merge base sends the caller down the reset-to-remote recovery, so
 * a shallow clone must not report one just because the common ancestor sits
 * below its grafted boundary. A depth-1 clone that commits locally and then
 * sees the remote advance still has a merge base — the boundary commit itself
 * — but a remote history rewrite can move the fork point out of reach. Fetch
 * the rest of the history once before concluding the histories are unrelated;
 * a full clone is unaffected because it is never shallow.
 */
export async function hasMergeBaseWithUpstreamAfterDeepening(
  memoryDir: string,
  runGit: MemoryGitRunner,
): Promise<boolean> {
  if (await hasMergeBaseWithUpstream(memoryDir, runGit)) return true;
  if (!(await isShallowMemoryRepo(memoryDir, runGit))) return false;

  debugLog(
    "memfs-git",
    "No merge base in a shallow memory repo; fetching full history before recovery",
  );
  try {
    await runGit(memoryDir, ["fetch", "--unshallow", "origin"]);
  } catch (error) {
    debugWarn(
      "memfs-git",
      `Failed to unshallow memory repo: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
  return hasMergeBaseWithUpstream(memoryDir, runGit);
}
