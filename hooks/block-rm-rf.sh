#!/bin/bash
# Block dangerous rm -rf commands

input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name')

# Only check Bash commands
if [ "$tool_name" != "Bash" ]; then
  exit 0
fi

command=$(echo "$input" | jq -r '.tool_input.command')

# Block rm when both a recursive and a force flag are present, however
# the flags are spelled (-rf, -r -f, --recursive --force, etc.)
if echo "$command" | grep -qE '\brm\b' \
  && echo "$command" | grep -qE '(^|\s)(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b' \
  && echo "$command" | grep -qE '(^|\s)(-[a-zA-Z]*[fF][a-zA-Z]*|--force)\b'; then
  echo "Blocked: rm -rf commands must be ran manually, use rm and rmdir instead." >&2
  exit 2
fi

exit 0
