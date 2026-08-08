/**
 * Serialization for `.git/config` mutations on the memory repo.
 *
 * `git config` takes an exclusive `.git/config.lock` for its whole
 * read-modify-write and exits non-zero rather than waiting, so two config
 * mutations against one repo cannot overlap. Memory-repo bootstrap has several
 * independent config writers — identity reconciliation, git-ops preparation,
 * and the credential helper — so contention is ordinary rather than
 * exceptional, and must not surface as a fatal error.
 *
 * Serializing removes the contention this process causes itself; the retry
 * covers writers it does not control (a second harness on the same agent, a
 * commit hook, or the operator's own git).
 */

import { resolve } from "node:path";
import { debugWarn } from "@/utils/debug";

// Two spellings depending on git version and whether the lock file already
// existed: "could not lock config file .git/config: File exists" and
// "Unable to create '<path>/config.lock': File exists".
const GIT_CONFIG_LOCK_ERROR_RE =
  /(could not lock config file|unable to create '[^']*config\.lock')/i;

const GIT_CONFIG_LOCK_ATTEMPTS = 5;
const GIT_CONFIG_LOCK_BASE_DELAY_MS = 25;

/** Returns true when a git error is `.git/config` lock contention. */
export function isGitConfigLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return GIT_CONFIG_LOCK_ERROR_RE.test(message);
}

/**
 * In-flight config mutation per repo directory. Keyed by resolved path: the
 * same repo is reached through different spellings (symlinked temp dirs,
 * relative cwds).
 */
const gitConfigMutationQueues = new Map<string, Promise<unknown>>();

/**
 * Run `mutate` serialized against other config mutations of the same repo,
 * retrying while the config lock is held.
 *
 * `mutate` performs the git invocation; it is supplied by the caller so this
 * module stays free of the git runner (and of a cycle back to memory-git).
 * It may be invoked more than once, so it must be idempotent — every current
 * caller is a plain `git config` set/unset.
 */
export async function withSerializedGitConfigMutation(
  dir: string,
  mutate: () => Promise<unknown>,
): Promise<void> {
  const key = resolve(dir);
  const previous = gitConfigMutationQueues.get(key) ?? Promise.resolve();
  // Chain off the previous mutation's settlement, not its success — one failed
  // write must not cancel every write queued behind it.
  const task = previous
    .catch(() => {})
    .then(() => retryWhileConfigLocked(dir, mutate));
  gitConfigMutationQueues.set(key, task);
  try {
    await task;
  } finally {
    // Only the queue tail clears the entry, or a slow write would drop the
    // queue that later writes are still chained to.
    if (gitConfigMutationQueues.get(key) === task) {
      gitConfigMutationQueues.delete(key);
    }
  }
}

async function retryWhileConfigLocked(
  dir: string,
  mutate: () => Promise<unknown>,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await mutate();
      return;
    } catch (error) {
      if (!isGitConfigLockError(error) || attempt >= GIT_CONFIG_LOCK_ATTEMPTS) {
        throw error;
      }
      const delayMs = GIT_CONFIG_LOCK_BASE_DELAY_MS * 2 ** (attempt - 1);
      debugWarn(
        "memfs-git",
        `git config contended on .git/config.lock in ${dir} (attempt ${attempt}/${GIT_CONFIG_LOCK_ATTEMPTS}); retrying in ${delayMs}ms`,
      );
      await new Promise((done) => setTimeout(done, delayMs));
    }
  }
}
