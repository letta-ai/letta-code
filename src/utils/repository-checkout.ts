import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileLock } from "./file-lock";

/** Publish a fresh checkout only after clone, credentials, and hooks are ready. */
export async function withRepositoryCheckout<T>(
  directory: string,
  work: (directory: string, fresh: boolean) => Promise<T>,
): Promise<T> {
  await mkdir(dirname(directory), { recursive: true });
  return withFileLock(
    `${directory}.checkout.lock`,
    async () => {
      if (existsSync(directory)) return work(directory, false);
      const staging = await mkdtemp(`${directory}.checkout-`);
      try {
        const result = await work(staging, true);
        await rename(staging, directory);
        return result;
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    },
    { timeoutMs: 600_000, staleMs: 1_800_000 },
  );
}
