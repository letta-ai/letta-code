#!/bin/bash
# Block dangerous rm -rf commands

if ! input=$(cat); then
  echo "Blocked: failed to read hook input." >&2
  exit 2
fi

if ! tool_name=$(jq -er '.tool_name | strings' <<< "$input"); then
  echo "Blocked: hook input must contain a string tool_name." >&2
  exit 2
fi

# Only check Bash commands
if [ "$tool_name" != "Bash" ]; then
  exit 0
fi

if ! command=$(jq -er '.tool_input.command | strings' <<< "$input"); then
  echo "Blocked: Bash hook input must contain a string tool_input.command." >&2
  exit 2
fi

# Check for rm -rf pattern (handles -rf, -fr, -rfi, etc.)
grep_status=0
grep -qE 'rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)' <<< "$command" || grep_status=$?

case "$grep_status" in
  0)
    echo "Blocked: rm -rf commands must be ran manually, use rm and rmdir instead." >&2
    exit 2
    ;;
  1)
    exit 0
    ;;
  *)
    echo "Blocked: failed to inspect the Bash command." >&2
    exit 2
    ;;
esac
