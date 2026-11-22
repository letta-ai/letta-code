#!/bin/bash
# Block dangerous rm -rf commands

input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name')

# Only check Bash commands
if [ "$tool_name" != "Bash" ]; then
  exit 0
fi

command=$(echo "$input" | jq -r '.tool_input.command')

# Block rm when recursive and force flags are both present, however they
# are spelled: combined short flags (-rf, -fr, -Rf), split short flags
# (-r -f), and long forms (--recursive --force), in any order. The
# command is split on separators, and only tokens after rm are checked,
# so flags of other commands in the same line (ls -f; rm -r) do not trip
# the guard.
should_block=false
while IFS= read -r segment; do
  has_rm=false
  has_recursive=false
  has_force=false
  for word in $segment; do
    if $has_rm; then
      case "$word" in
        --)
          has_rm=false
          ;;
        --recursive)
          has_recursive=true
          ;;
        --force)
          has_force=true
          ;;
        -[a-zA-Z]*)
          case "$word" in
            *[rR]*) has_recursive=true ;;
          esac
          case "$word" in
            *[f]*) has_force=true ;;
          esac
          ;;
      esac
    else
      case "$word" in
        rm | */rm) has_rm=true ;;
      esac
    fi
  done
  if $has_recursive && $has_force; then
    should_block=true
  fi
done < <(printf '%s\n' "$command" | tr ';|&\r\n' '\n\n\n\n\n')

if $should_block; then
  echo "Blocked: rm -rf commands must be ran manually, use rm and rmdir instead." >&2
  exit 2
fi

exit 0
