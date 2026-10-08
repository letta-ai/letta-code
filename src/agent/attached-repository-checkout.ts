import { existsSync } from "node:fs";
import { join } from "node:path";
import { withRepositoryCheckout } from "@/utils/repository-checkout";
import { assertCaseCompatibleCheckout } from "./memory-git-case-collisions";

export interface RepositoryMountGitArgs {
  agentId: string;
  repositoryName: string;
  directory: string;
  remoteUrl: string;
  token: string;
  publishedDirectory?: string;
}

export interface RepositoryCheckoutGit {
  git: (
    directory: string,
    args: string[],
    token?: string,
  ) => Promise<{ stdout: string }>;
  gitWithRetry: (
    directory: string,
    args: string[],
    token?: string,
    options?: { operation?: string; timeoutMs?: number },
  ) => Promise<{ stdout: string }>;
  prepare: (args: RepositoryMountGitArgs) => Promise<void>;
  installHook: (directory: string) => void;
  cloneTimeoutMs: number;
}

/** Check the prospective Git tree before materializing it on the host FS. */
export async function syncAttachedRepositoryCheckout(
  args: RepositoryMountGitArgs,
  ops: RepositoryCheckoutGit,
): Promise<void> {
  await withRepositoryCheckout(args.directory, async (directory, fresh) => {
    const checkoutArgs = {
      ...args,
      publishedDirectory: args.directory,
      directory,
    };
    const git = (path: string, argv: string[]) =>
      ops.git(path, argv, args.token);

    if (fresh) {
      await ops.gitWithRetry(
        directory,
        ["clone", "--no-checkout", args.remoteUrl, "."],
        args.token,
        {
          operation: `clone repository ${args.repositoryName}`,
          timeoutMs: ops.cloneTimeoutMs,
        },
      );
      if (await assertCaseCompatibleCheckout(directory, "HEAD", git)) {
        await git(directory, ["checkout", "--force"]);
      }
    } else if (!existsSync(join(directory, ".git"))) {
      throw new Error(
        `repository mount path already exists and is not a git repository: ${args.directory}`,
      );
    } else {
      await assertCaseCompatibleCheckout(directory, "HEAD", git);
      await ops.prepare(checkoutArgs);
      await ops.gitWithRetry(
        directory,
        ["fetch", "origin", "main"],
        args.token,
        { operation: `fetch repository ${args.repositoryName}` },
      );
      await assertCaseCompatibleCheckout(directory, "FETCH_HEAD", git);
      await git(directory, ["merge", "--ff-only", "FETCH_HEAD"]);
    }

    await ops.prepare(checkoutArgs);
    ops.installHook(directory);
  });
}
