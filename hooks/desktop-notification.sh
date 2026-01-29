#!/bin/bash
# Send desktop notification using osascript (macOS)

input=$(cat)
message=$(echo "$input" | jq -r '.message')
level=$(echo "$input" | jq -r '.level')

# Display the notification (show subtitle only for warning/error)
if [ "$level" = "error" ]; then
  osascript -e "display notification \"$message\" with title \"Letta Code\" subtitle \"Error\""
elif [ "$level" = "warning" ]; then
  osascript -e "display notification \"$message\" with title \"Letta Code\" subtitle \"Warning\""
else
  osascript -e "display notification \"$message\" with title \"Letta Code\""
fi

exit 0
