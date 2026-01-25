#!/bin/bash
# Block dangerous rm -rf commands

input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name')

# Only check Bash commands
if [ "$tool_name" != "Bash" ]; then
  exit 0
fi

command=$(echo "$input" | jq -r '.tool_input.command')

# Check for rm -rf pattern (handles -rf, -fr, -rfi, etc.)
if echo "$command" | grep -qE 'rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)'; then
  echo "Blocked: rm -rf commands must be ran manually, use rm and rmdir instead." >&2
  exit 2
fi

exit 0
