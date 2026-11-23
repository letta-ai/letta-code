#!/bin/bash

if git diff --quiet HEAD 2>/dev/null; then
    echo "No changes, skipping."
    exit 0
fi

output=$(tsc --noEmit --pretty 2>&1)
exit_code=$?

if [ $exit_code -eq 0 ]; then
    echo "$output"
    exit 0
else
    echo "$output" >&2
    exit 2
fi
