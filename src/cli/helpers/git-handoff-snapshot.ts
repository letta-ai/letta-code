import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GithubRepositoryRef,
  getGithubRepositoryForDirectory,
} from "./git-context";

const MAX_HANDOFF_FILE_BYTES = 10 * 1024 * 1024;
const SENSITIVE_BASENAME =
  /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?)$/i;
const SAFE_TEMPLATE_BASENAME =
  /(?:^|[._-])(?:example|sample|template)(?:\.[^.]+)?$/i;

function runGit(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; trim?: boolean } = {},
): string {
  const output = execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return options.trim === false ? output : output.trim();
}

function nulPaths(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function changedPaths(cwd: string): string[] {
  return nulPaths(
    runGit(cwd, ["diff", "--name-only", "-z", "HEAD"], { trim: false }),
  );
}

function stagedNewPaths(cwd: string): string[] {
  return nulPaths(
    runGit(cwd, ["diff", "--cached", "--name-only", "--diff-filter=A", "-z"], {
      trim: false,
    }),
  );
}

function assertSafeSnapshotPaths(cwd: string, paths: string[]): void {
  const unsafe: string[] = [];
  const oversized: string[] = [];
  for (const path of paths) {
    const basename = path.split("/").at(-1) ?? path;
    try {
      const stat = statSync(join(cwd, path));
      if (
        SENSITIVE_BASENAME.test(basename) &&
        !SAFE_TEMPLATE_BASENAME.test(basename)
      ) {
        unsafe.push(path);
      }
      if (stat.isFile() && stat.size > MAX_HANDOFF_FILE_BYTES) {
        oversized.push(path);
      }
    } catch {
      // Deleted paths do not need file-size checks.
    }
  }
  if (unsafe.length > 0) {
    throw new Error(
      `Refusing to snapshot likely-secret files: ${unsafe.join(", ")}. Stash or remove them before moving to Cloud.`,
    );
  }
  if (oversized.length > 0) {
    throw new Error(
      `Refusing to snapshot files larger than 10 MB: ${oversized.join(", ")}.`,
    );
  }

  const dirtySubmodules = runGit(cwd, ["submodule", "status", "--recursive"])
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("+") || line.startsWith("-") || line.startsWith("U"),
    );
  if (dirtySubmodules.length > 0) {
    throw new Error(
      "Dirty or unavailable submodules cannot be included in a Cloud handoff yet.",
    );
  }
}

export function createPrivateSnapshotCommit(
  cwd: string,
  message = "Letta Cloud handoff snapshot",
): { commit: string; changedFiles: string[] } {
  const paths = changedPaths(cwd);
  assertSafeSnapshotPaths(cwd, paths);
  if (paths.length === 0) {
    return { commit: runGit(cwd, ["rev-parse", "HEAD"]), changedFiles: [] };
  }

  const tempDir = mkdtempSync(join(tmpdir(), "letta-cloud-handoff-"));
  const indexPath = join(tempDir, "index");
  const env = {
    ...process.env,
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: "Letta Cloud Handoff",
    GIT_AUTHOR_EMAIL: "handoff@letta.com",
    GIT_COMMITTER_NAME: "Letta Cloud Handoff",
    GIT_COMMITTER_EMAIL: "handoff@letta.com",
  };
  try {
    runGit(cwd, ["read-tree", "HEAD"], { env });
    runGit(cwd, ["add", "-u", "--", "."], { env });
    const selectedNewPaths = stagedNewPaths(cwd);
    if (selectedNewPaths.length > 0) {
      runGit(cwd, ["add", "--", ...selectedNewPaths], { env });
    }
    const tree = runGit(cwd, ["write-tree"], { env });
    const parent = runGit(cwd, ["rev-parse", "HEAD"]);
    const commit = runGit(
      cwd,
      ["commit-tree", tree, "-p", parent, "-m", message],
      {
        env,
      },
    );
    return { commit, changedFiles: paths };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export interface PreparedGithubHandoff {
  repository: GithubRepositoryRef & { handoffRef?: string };
  baseCommit: string;
  changedFiles: string[];
  privateRef: string | null;
}

export function prepareGithubHandoff(
  cwd: string,
  conversationId: string,
): PreparedGithubHandoff | null {
  const repository = getGithubRepositoryForDirectory(cwd);
  if (!repository) {
    try {
      runGit(cwd, ["rev-parse", "--git-dir"]);
    } catch {
      return null;
    }
    throw new Error(
      "/cloud can only transfer repository state when origin is a GitHub remote.",
    );
  }

  const branch =
    runGit(cwd, ["branch", "--show-current"]) ||
    `letta/cloud-handoff-${conversationId.slice(-8)}`;
  const baseCommit = runGit(cwd, ["rev-parse", "HEAD"]);
  const { commit, changedFiles } = createPrivateSnapshotCommit(cwd);
  let privateRef: string | null = null;
  const remoteRef = (() => {
    try {
      return runGit(cwd, ["rev-parse", `refs/remotes/origin/${branch}`]);
    } catch {
      return null;
    }
  })();

  if (changedFiles.length > 0 || remoteRef !== commit) {
    privateRef = `refs/letta/handoffs/${conversationId}/${randomUUID()}`;
    runGit(cwd, ["push", "origin", `${commit}:${privateRef}`]);
  }

  return {
    repository: {
      ...repository,
      branch,
      ref: commit,
      ...(privateRef ? { handoffRef: privateRef } : {}),
    },
    baseCommit,
    changedFiles,
    privateRef,
  };
}

export function deletePrivateHandoffRef(
  cwd: string,
  privateRef: string | null,
): void {
  if (!privateRef) return;
  try {
    runGit(cwd, ["push", "origin", `:${privateRef}`]);
  } catch {
    // Best-effort cleanup; the ref is namespaced and can be reaped server-side.
  }
}
