/**
 * Git hook scripts installed into agent and shared memory repositories.
 *
 * The pre-commit hook validates memory markdown frontmatter; the post-commit
 * hook mirrors commits to an optional user-configured memory-repository
 * remote. Both are (re)installed by the CLI harness on clone/pull/init —
 * see memory-git.ts.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateMemoryFileFrontmatter } from "@/memory-frontmatter";
import { debugLog } from "@/utils/debug";
import {
  MEMORY_CONSTRAINTS_CONFIG_PATH,
  MEMORY_CONSTRAINTS_VALIDATOR_NAME,
  MEMORY_CONSTRAINTS_VALIDATOR_SCRIPT,
} from "./memory-constraints";

const MEMORY_LAYOUT_POLICY = "letta-memory-layout-policy";
type MemoryLayoutPolicy = "legacy-only" | "root-marker" | "shared-memory";

/**
 * Bash pre-commit hook that validates frontmatter in memory .md files.
 *
 * Rules:
 * - Frontmatter is REQUIRED (must start with ---)
 * - Must be properly closed with ---
 * - Required fields: description (non-empty string)
 * - read_only is a PROTECTED field: agent cannot add, remove, or change it.
 *   Files where HEAD has read_only: true cannot be modified at all.
 * - Only allowed agent-editable key: description
 * - Legacy key 'limit' is tolerated for backward compatibility
 * - read_only may exist (from server) but agent must not change it
 * - Optional file-size and depth constraints come from .memfs.config.json
 */
export const PRE_COMMIT_HOOK_SCRIPT = `#!/usr/bin/env bash
# Validate frontmatter in staged memory .md files
# Installed by Letta Code CLI

errors=""

memory_layout_policy_file="$(git rev-parse --git-common-dir 2>/dev/null)/${MEMORY_LAYOUT_POLICY}"
memory_layout_policy=$(cat "$memory_layout_policy_file" 2>/dev/null || true)

validate_memory_constraints() {
  if { [ "$memory_layout_policy" = "root-marker" ] && \
       { git cat-file -e ":MEMORY.md" 2>/dev/null || \
         git cat-file -e "HEAD:MEMORY.md" 2>/dev/null; }; } || \
     git cat-file -e ":${MEMORY_CONSTRAINTS_CONFIG_PATH}" 2>/dev/null || \
     git cat-file -e "HEAD:${MEMORY_CONSTRAINTS_CONFIG_PATH}" 2>/dev/null; then
    node "$(git rev-parse --git-common-dir)/hooks/${MEMORY_CONSTRAINTS_VALIDATOR_NAME}" || exit $?
  fi
}

validate_memory_file() {
  local result
  result=$(node - "$1" "$2" <<'LETTA_MEMORY_FRONTMATTER'
const { execFileSync, spawnSync } = require("node:child_process");
const validateMemoryFileFrontmatter = ${validateMemoryFileFrontmatter.toString()};
const [path, format] = process.argv.slice(2);
try {
  const content = execFileSync("git", ["show", ":" + path], { encoding: "utf8", maxBuffer: Infinity, stdio: ["ignore", "pipe", "pipe"] });
  let previousContent = null;
  if (format === "legacy") {
    const previous = spawnSync("git", ["show", "HEAD:" + path], { encoding: "utf8", maxBuffer: Infinity, stdio: ["ignore", "pipe", "pipe"] });
    if (previous.error) throw previous.error;
    if (previous.status === 0) previousContent = previous.stdout;
  }
  const errors = validateMemoryFileFrontmatter({ path, content, previousContent, format });
  for (const error of errors) console.log("  " + error);
} catch {
  console.error("Memory validation could not read Git contents. No files were committed.");
  process.exit(1);
}
LETTA_MEMORY_FRONTMATTER
  ) || exit $?
  if [ -n "$result" ]; then
    errors="$errors\\n$result"
  fi
}

use_v2_validation=false
case "$memory_layout_policy" in
  shared-memory) use_v2_validation=true ;;
  root-marker)
    if git cat-file -e ":MEMORY.md" 2>/dev/null || \
       git cat-file -e "HEAD:MEMORY.md" 2>/dev/null; then
      use_v2_validation=true
    fi
    ;;
esac

if [ "$use_v2_validation" = "true" ]; then
  for file in $(git diff --cached --name-only --diff-filter=ACMR | grep -E '^skills/[^/]+\\.md$' || true); do
    errors="$errors\\n  $file: invalid skill path (skills must be folders). Use skills/<name>/SKILL.md"
  done

  while IFS= read -r file; do
    case "$file" in
      skills/*) continue ;;
    esac

    projected=true
    if [ "$memory_layout_policy" = "root-marker" ]; then
      case "$file" in
        */*)
          dir=\${file%/*}
          while [ -n "$dir" ]; do
            if ! git cat-file -e ":$dir/MEMORY.md" 2>/dev/null; then
              projected=false
              break
            fi
            case "$dir" in
              */*) dir=\${dir%/*} ;;
              *) dir="" ;;
            esac
          done
          ;;
      esac
    fi
    [ "$projected" = "true" ] && validate_memory_file "$file" "memfs-v2"
  done < <(git ls-files '*.md')

  if [ -n "$errors" ]; then
    echo "Memory validation failed:"
    echo -e "$errors"
    exit 1
  fi
  validate_memory_constraints
  exit 0
fi

# Skills must always be directories: skills/<name>/SKILL.md
# Reject legacy flat skill files (both current and legacy repo layouts).
for file in $(git diff --cached --name-only --diff-filter=ACMR | grep -E '^(memory/)?skills/[^/]+\\.md$' || true); do
  errors="$errors\\n  $file: invalid skill path (skills must be folders). Use skills/<name>/SKILL.md"
done

# Match .md files under system/ or reference/ (with optional memory/ prefix).
# Skip skill SKILL.md files — they use a different frontmatter format.
for file in $(git diff --cached --name-only --diff-filter=ACM | grep -E '^(memory/)?(system|reference)/.*\\.md$'); do
  validate_memory_file "$file" "legacy"
done

if [ -n "$errors" ]; then
  echo "Frontmatter validation failed:"
  echo -e "$errors"
  exit 1
fi
validate_memory_constraints
`;

/**
 * Install the pre-commit hook for frontmatter validation.
 */
function installPreCommitHookWithPolicy(
  dir: string,
  policy: MemoryLayoutPolicy,
): void {
  const hooksDir = join(dir, ".git", "hooks");
  const hookPath = join(hooksDir, "pre-commit");

  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }

  writeFileSync(hookPath, PRE_COMMIT_HOOK_SCRIPT, "utf-8");
  chmodSync(hookPath, 0o755);
  writeFileSync(
    join(hooksDir, MEMORY_CONSTRAINTS_VALIDATOR_NAME),
    MEMORY_CONSTRAINTS_VALIDATOR_SCRIPT,
    "utf8",
  );
  writeFileSync(join(dir, ".git", MEMORY_LAYOUT_POLICY), `${policy}\n`, "utf8");
  debugLog("memfs-git", "Installed pre-commit hook");
}

export function installPreCommitHook(
  dir: string,
  allowRootMemoryLayout = false,
): void {
  installPreCommitHookWithPolicy(
    dir,
    allowRootMemoryLayout ? "root-marker" : "legacy-only",
  );
}

/** Install memory validation for an attached shared repository. */
export function installSharedMemoryPreCommitHook(dir: string): void {
  installPreCommitHookWithPolicy(dir, "shared-memory");
}

/**
 * Bash post-commit hook that pushes memfs commits to an optional additional
 * git remote (the "memory repository" endpoint).
 *
 * Reads the remote URL from the repo's local git config
 * (`letta.memoryRepository.url`). No-op when the key is unset. Push runs
 * asynchronously in the background so commits stay fast, and failures are
 * logged to `.git/memory-repository-push.log` without blocking the user.
 *
 * URL is per-repo by design: each agent's memfs repo has its own `.git/config`,
 * so the endpoint is scoped to a single agent automatically.
 */
export const POST_COMMIT_HOOK_SCRIPT = `#!/usr/bin/env bash
# Letta Code: push memfs commits to the configured memory-repository remote.
# Installed by Letta Code CLI. Do not edit by hand — regenerated on startup.
url=$(git config --local --get letta.memoryRepository.url 2>/dev/null)
[ -z "$url" ] && exit 0
branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || exit 0
[ -z "$branch" ] && exit 0
# Reflection and other harness worktrees commit on temporary branches; only the
# main MemFS checkout should push to the optional memory repository remote.
[ "$branch" != "main" ] && exit 0
log="$(git rev-parse --git-dir)/memory-repository-push.log"
(
  {
    printf '\\n--- %s %s on %s ---\\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$(git rev-parse --short HEAD)" "$branch"
    git push --quiet "$url" "$branch":"$branch" 2>&1
    echo "exit=$?"
  } >> "$log" 2>&1
) &
disown 2>/dev/null || true
exit 0
`;

/**
 * Install the post-commit hook that pushes to `letta.memoryRepository.url`.
 * Hook is harmless when the config key is unset (no-ops on every commit).
 */
export function installPostCommitHook(dir: string): void {
  const hooksDir = join(dir, ".git", "hooks");
  const hookPath = join(hooksDir, "post-commit");

  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }

  writeFileSync(hookPath, POST_COMMIT_HOOK_SCRIPT, "utf-8");
  chmodSync(hookPath, 0o755);
  debugLog("memfs-git", "Installed post-commit memory-repository hook");
}

/** Refresh every harness-owned Git hook for an API-backed memory checkout. */
export function installMemoryGitHooks(dir: string): void {
  installPreCommitHook(dir, true);
  installPostCommitHook(dir);
}
