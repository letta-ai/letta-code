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
import { debugLog } from "@/utils/debug";

const MEMORY_LAYOUT_POLICY = "letta-memory-layout-policy";

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
 */
export const PRE_COMMIT_HOOK_SCRIPT = `#!/usr/bin/env bash
# Validate frontmatter in staged memory .md files
# Installed by Letta Code CLI

AGENT_EDITABLE_KEYS="description"
PROTECTED_KEYS="read_only"
ALL_KNOWN_KEYS="description read_only limit"
errors=""

memory_layout_policy_file="$(git rev-parse --git-common-dir 2>/dev/null)/${MEMORY_LAYOUT_POLICY}"
memory_layout_policy=$(cat "$memory_layout_policy_file" 2>/dev/null || true)

validate_v2_file() {
  local file="$1" staged first_line closing_line frontmatter line key value
  local has_name=false has_description=false
  staged=$(git show ":$file")

  if [ "\${file##*/}" = "MEMORY.md" ]; then
    first_line=$(echo "$staged" | head -1)
    if [ "$first_line" = "---" ]; then
      errors="$errors\\n  $file: MEMORY.md must not have frontmatter"
    fi
    return
  fi

  first_line=$(echo "$staged" | head -1)
  if [ "$first_line" != "---" ]; then
    errors="$errors\\n  $file: missing frontmatter (must start with ---)"
    return
  fi
  closing_line=$(echo "$staged" | tail -n +2 | grep -n '^---$' | head -1 | cut -d: -f1)
  if [ -z "$closing_line" ]; then
    errors="$errors\\n  $file: frontmatter opened but never closed (missing closing ---)"
    return
  fi
  frontmatter=$(echo "$staged" | tail -n +2 | head -n $((closing_line - 1)))

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    key=$(echo "$line" | cut -d: -f1 | sed 's/^ *//;s/ *$//')
    value=$(echo "$line" | cut -d: -f2- | sed 's/^ *//;s/ *$//')
    case "$key" in
      name)
        if [ "$has_name" = "true" ]; then
          errors="$errors\\n  $file: duplicate frontmatter key 'name'"
        fi
        has_name=true
        ;;
      description)
        if [ "$has_description" = "true" ]; then
          errors="$errors\\n  $file: duplicate frontmatter key 'description'"
        fi
        has_description=true
        ;;
      *)
        errors="$errors\\n  $file: unknown frontmatter key '$key' (allowed: name description)"
        continue
        ;;
    esac
    if [ -z "$value" ] || [ "$value" = '""' ] || [ "$value" = "''" ]; then
      errors="$errors\\n  $file: '$key' must not be empty"
    fi
  done <<< "$frontmatter"

  if [ "$has_name" = "false" ]; then
    errors="$errors\\n  $file: missing required field 'name'"
  fi
  if [ "$has_description" = "false" ]; then
    errors="$errors\\n  $file: missing required field 'description'"
  fi
}

if [ "$memory_layout_policy" = "root-marker" ] && git cat-file -e ":MEMORY.md" 2>/dev/null; then
  for file in $(git diff --cached --name-only --diff-filter=ACMR | grep -E '^skills/[^/]+\\.md$' || true); do
    errors="$errors\\n  $file: invalid skill path (skills must be folders). Use skills/<name>/SKILL.md"
  done

  while IFS= read -r file; do
    case "$file" in
      skills/*) continue ;;
    esac

    projected=true
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
    [ "$projected" = "true" ] && validate_v2_file "$file"
  done < <(git ls-files '*.md')

  if [ -n "$errors" ]; then
    echo "Memory validation failed:"
    echo -e "$errors"
    exit 1
  fi
  exit 0
fi

# Skills must always be directories: skills/<name>/SKILL.md
# Reject legacy flat skill files (both current and legacy repo layouts).
for file in $(git diff --cached --name-only --diff-filter=ACMR | grep -E '^(memory/)?skills/[^/]+\\.md$' || true); do
  errors="$errors\\n  $file: invalid skill path (skills must be folders). Use skills/<name>/SKILL.md"
done

# Helper: extract a frontmatter value from content
get_fm_value() {
  local content="$1" key="$2"
  local closing_line
  closing_line=$(echo "$content" | tail -n +2 | grep -n '^---$' | head -1 | cut -d: -f1)
  [ -z "$closing_line" ] && return
  echo "$content" | tail -n +2 | head -n $((closing_line - 1)) | grep "^$key:" | cut -d: -f2- | sed 's/^ *//;s/ *$//'
}

# Match .md files under system/ or reference/ (with optional memory/ prefix).
# Skip skill SKILL.md files — they use a different frontmatter format.
for file in $(git diff --cached --name-only --diff-filter=ACM | grep -E '^(memory/)?(system|reference)/.*\\.md$'); do
  staged=$(git show ":$file")

  # Frontmatter is required
  first_line=$(echo "$staged" | head -1)
  if [ "$first_line" != "---" ]; then
    errors="$errors\\n  $file: missing frontmatter (must start with ---)"
    continue
  fi

  # Check frontmatter is properly closed
  closing_line=$(echo "$staged" | tail -n +2 | grep -n '^---$' | head -1 | cut -d: -f1)
  if [ -z "$closing_line" ]; then
    errors="$errors\\n  $file: frontmatter opened but never closed (missing closing ---)"
    continue
  fi

  # Check read_only protection against HEAD version
  head_content=$(git show "HEAD:$file" 2>/dev/null || true)
  if [ -n "$head_content" ]; then
    head_ro=$(get_fm_value "$head_content" "read_only")
    if [ "$head_ro" = "true" ]; then
      errors="$errors\\n  $file: file is read_only and cannot be modified"
      continue
    fi
  fi

  # Extract frontmatter lines
  frontmatter=$(echo "$staged" | tail -n +2 | head -n $((closing_line - 1)))

  # Track required fields
  has_description=false

  # Validate each line
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    # Skip YAML multiline continuation lines (indented lines that continue a previous value)
    case "$line" in
      " "*|$'\t'*) continue ;;
    esac

    key=$(echo "$line" | cut -d: -f1 | tr -d ' ')
    value=$(echo "$line" | cut -d: -f2- | sed 's/^ *//;s/ *$//')

    # Check key is known
    known=false
    for k in $ALL_KNOWN_KEYS; do
      if [ "$key" = "$k" ]; then
        known=true
        break
      fi
    done
    if [ "$known" = "false" ]; then
      errors="$errors\\n  $file: unknown frontmatter key '$key' (allowed: $ALL_KNOWN_KEYS)"
      continue
    fi

    # Check if agent is trying to modify a protected key
    for k in $PROTECTED_KEYS; do
      if [ "$key" = "$k" ]; then
        # Compare against HEAD — if value changed (or key was added), reject
        if [ -n "$head_content" ]; then
          head_val=$(get_fm_value "$head_content" "$key")
          if [ "$value" != "$head_val" ]; then
            errors="$errors\\n  $file: '$key' is a protected field and cannot be changed by the agent"
          fi
        else
          # New file with read_only — agent shouldn't set this
          errors="$errors\\n  $file: '$key' is a protected field and cannot be set by the agent"
        fi
      fi
    done

    # Validate value types
    case "$key" in
      limit)
        # Legacy field accepted for backward compatibility.
        ;;
      description)
        has_description=true
        if [ -z "$value" ]; then
          errors="$errors\\n  $file: 'description' must not be empty"
        fi
        ;;
    esac
  done <<< "$frontmatter"

  # Check required fields
  if [ "$has_description" = "false" ]; then
    errors="$errors\\n  $file: missing required field 'description'"
  fi

  # Check if protected keys were removed (existed in HEAD but not in staged)
  if [ -n "$head_content" ]; then
    for k in $PROTECTED_KEYS; do
      head_val=$(get_fm_value "$head_content" "$k")
      if [ -n "$head_val" ]; then
        staged_val=$(get_fm_value "$staged" "$k")
        if [ -z "$staged_val" ]; then
          errors="$errors\\n  $file: '$k' is a protected field and cannot be removed by the agent"
        fi
      fi
    done
  fi
done

if [ -n "$errors" ]; then
  echo "Frontmatter validation failed:"
  echo -e "$errors"
  exit 1
fi
`;

/**
 * Install the pre-commit hook for frontmatter validation.
 */
export function installPreCommitHook(
  dir: string,
  allowRootMemoryLayout = false,
): void {
  const hooksDir = join(dir, ".git", "hooks");
  const hookPath = join(hooksDir, "pre-commit");

  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }

  writeFileSync(hookPath, PRE_COMMIT_HOOK_SCRIPT, "utf-8");
  chmodSync(hookPath, 0o755);
  writeFileSync(
    join(dir, ".git", MEMORY_LAYOUT_POLICY),
    allowRootMemoryLayout ? "root-marker\n" : "legacy-only\n",
    "utf8",
  );
  debugLog("memfs-git", "Installed pre-commit hook");
}

/** Install root-layout memory validation for an attached shared repository. */
export function installSharedMemoryPreCommitHook(dir: string): void {
  installPreCommitHook(dir, true);
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
