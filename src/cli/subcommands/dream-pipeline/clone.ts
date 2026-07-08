// Give a batch reflection agent an isolated copy of the primary agent's
// memory filesystem to edit: a local `git clone` of the memfs repo at its
// current revision. The agent reconciles its batch's learnings against
// existing memory in place; the aggregator later reads each batch's diff
// against the shared base revision and synthesizes one edit onto the real
// memfs. Clones are fully independent repos, so any number of batches can
// run concurrently without touching the parent repository.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

/**
 * Clone the memory filesystem into outputDir and return the base revision the
 * clone starts from (the revision batch diffs are taken against).
 */
export async function cloneMemoryTree(
  memoryDir: string,
  outputDir: string,
): Promise<string> {
  await execFileAsync("git", ["clone", "--quiet", memoryDir, outputDir]);
  // Commits are authored per the reflection prompt; the committer identity
  // just needs to exist inside the clone.
  await git(outputDir, ["config", "user.name", "Dream Reflection"]);
  await git(outputDir, ["config", "user.email", "dream@letta.com"]);
  return git(outputDir, ["rev-parse", "HEAD"]);
}
