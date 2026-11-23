import { resolve } from "node:path";
import { debugWarn } from "@/utils/debug";

const GIT_CONFIG_LOCK_ERROR_RE =
  /(could not lock config file|unable to create '[^']*config\.lock')/i;

const GIT_CONFIG_LOCK_ATTEMPTS = 5;
const GIT_CONFIG_LOCK_BASE_DELAY_MS = 25;

export function isGitConfigLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return GIT_CONFIG_LOCK_ERROR_RE.test(message);
}

const gitConfigMutationQueues = new Map<string, Promise<unknown>>();

export async function withSerializedGitConfigMutation(
  dir: string,
  mutate: () => Promise<unknown>,
): Promise<void> {
  const key = resolve(dir);
  const previous = gitConfigMutationQueues.get(key) ?? Promise.resolve();
  const task = previous
    .catch(() => {})
    .then(() => retryWhileConfigLocked(dir, mutate));
  gitConfigMutationQueues.set(key, task);
  try {
    await task;
  } finally {
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
