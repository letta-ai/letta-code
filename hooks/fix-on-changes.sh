#!/bin/bash
# Hook script: Run bun run fix if there are uncommitted changes
# Triggered on: Stop event

# Check if there are any uncommitted changes (staged or unstaged)
if git diff --quiet HEAD 2>/dev/null; then
    echo "No changes, skipping."
    exit 0
fi

# Run fix - capture output and send to stderr on failure
output=$(bun run fix 2>&1)
exit_code=$?

if [ $exit_code -eq 0 ]; then
    echo "$output"
    exit 0
else
    echo "$output" >&2
    exit 2
fi
