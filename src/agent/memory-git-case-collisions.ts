/** Detect tracked paths that a case-insensitive checkout cannot represent. */

export type GitCaseCheck = (
  directory: string,
  args: string[],
) => Promise<{ stdout: string }>;

export function findCaseCollidingTrackedPath(
  paths: readonly string[],
): boolean {
  const prefixes = new Map<string, string>();
  for (const path of paths) {
    let prefix = "";
    for (const segment of path.split("/")) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      const folded = prefix.toLowerCase();
      const prior = prefixes.get(folded);
      if (prior && prior !== prefix) return true;
      prefixes.set(folded, prefix);
    }
  }
  return false;
}

export async function assertCaseCompatibleCheckout(
  directory: string,
  tree: string,
  git: GitCaseCheck,
): Promise<boolean> {
  // An empty repository has no tree to inspect or materialize yet.
  const head = await git(directory, [
    "rev-parse",
    "--verify",
    "--quiet",
    tree,
  ]).catch(() => null);
  if (!head) return false;

  const { stdout: ignorecase } = await git(directory, [
    "config",
    "--bool",
    "--get",
    "core.ignorecase",
  ]).catch(() => ({ stdout: "" }));
  if (ignorecase.trim() !== "true" && process.platform !== "win32") {
    return true;
  }

  const { stdout } = await git(directory, [
    "ls-tree",
    "-r",
    "-z",
    "--name-only",
    tree,
  ]);
  if (!findCaseCollidingTrackedPath(stdout.split("\0").filter(Boolean))) {
    return true;
  }
  throw new Error(
    "This shared-memory repository tracks paths that differ only by case. " +
      "A case-insensitive checkout cannot safely represent both. " +
      "Resolve the duplicate names on a case-sensitive filesystem, then sync again. " +
      "No checkout changes were applied.",
  );
}
