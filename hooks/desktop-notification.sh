#!/bin/bash

set -euo pipefail

input=$(cat)
message=$(echo "$input" | jq -r '.message')
level=$(echo "$input" | jq -r '.level')

if [ "$level" = "error" ]; then
  osascript -e "display notification \"$message\" with title \"Letta Code\" subtitle \"Error\""
elif [ "$level" = "warning" ]; then
  osascript -e "display notification \"$message\" with title \"Letta Code\" subtitle \"Warning\""
else
  osascript -e "display notification \"$message\" with title \"Letta Code\""
fi

exit 0
