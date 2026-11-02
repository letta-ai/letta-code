import { execFile } from "node:child_process";
import type {
  SandboxGithubRepository,
  SandboxRepositorySpec,
} from "./environments";

/**
 * Runs a command without a shell. On failure it rejects with an Error whose
 * `exitCode` is the process exit code (null when it never exited normally).
 */
export type RunCommand = (
  command: string,
  args: string[],
  options: { timeoutMs: number; env: NodeJS.ProcessEnv },
) => Promise<string>;

function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number; env: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: options.timeoutMs, env: options.env, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve(String(stdout));
        const code = typeof error.code === "number" ? error.code : null;
        const detail = String(stderr).trim() || error.message;
        reject(Object.assign(new Error(detail), { exitCode: code }));
      },
    );
  });
}

const COMMIT_SHA = /^[0-9a-fA-F]{40}$/;
const RESOLVE_TIMEOUT_MS = 30_000;

/**
 * Resolve a branch tip to its commit SHA, as the caller's own credentials see
 * it. `git ls-remote` over HTTPS uses the configured git credential helper, so
 * private repositories the caller can clone resolve too. If git cannot read the
 * repository, the GitHub CLI's login is tried before giving up.
 */
export async function resolveGithubBranchCommit(
  repository: { owner: string; repo: string; branch: string },
  run: RunCommand = runCommand,
): Promise<string> {
  const { owner, repo, branch } = repository;
  const name = `${owner}/${repo}@${branch}`;
  // Never prompt for credentials from a background launch.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const options = { timeoutMs: RESOLVE_TIMEOUT_MS, env };
  let gitError: unknown;
  try {
    // `refs/heads/<branch>` is a pattern, never an option, even for odd names.
    const output = await run(
      "git",
      [
        "ls-remote",
        "--exit-code",
        `https://github.com/${owner}/${repo}.git`,
        `refs/heads/${branch}`,
      ],
      options,
    );
    const sha = output
      .split("\n")
      .map((line) => line.split("\t"))
      .find(([, ref]) => ref === `refs/heads/${branch}`)?.[0];
    if (sha && COMMIT_SHA.test(sha)) return sha.toLowerCase();
    gitError = new Error("git ls-remote returned no matching branch");
  } catch (error) {
    // Exit 2: the repository answered and has no such branch.
    if (Reflect.get(Object(error), "exitCode") === 2)
      throw new Error(`Branch "${branch}" not found in ${owner}/${repo}.`);
    gitError = error;
  }
  try {
    const output = await run(
      "gh",
      [
        "api",
        `repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
        "-H",
        "Accept: application/vnd.github.sha",
      ],
      options,
    );
    const sha = output.trim();
    if (COMMIT_SHA.test(sha)) return sha.toLowerCase();
  } catch {
    // Report the git failure: it is the primary path and the clearer message.
  }
  const reason = gitError instanceof Error ? gitError.message : "";
  throw new Error(
    `Couldn't resolve ${name} to a commit${reason ? `: ${reason}` : ""}. Check the branch exists and that this machine's git or gh credentials can read the repository, or pass a 40-character commit SHA.`,
  );
}

/** Replace each `branch` with the commit it points at; commits pass through. */
export async function resolveSandboxRepositoryBranches(
  specs: SandboxRepositorySpec[],
  resolveBranch: typeof resolveGithubBranchCommit = resolveGithubBranchCommit,
): Promise<SandboxGithubRepository[]> {
  return Promise.all(
    specs.map(async ({ branch, ...repository }) =>
      branch === undefined
        ? repository
        : {
            ...repository,
            commit: await resolveBranch({ ...repository, branch }),
          },
    ),
  );
}
