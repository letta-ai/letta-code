#!/bin/bash
# Send desktop notification using osascript (macOS)

input=$(cat)
message=$(echo "$input" | jq -r '.message')
level=$(echo "$input" | jq -r '.level')

# Pass the message to AppleScript as an argument instead of splicing it into
# the script source, so quotes and backslashes in the message stay literal.
notify() {
  osascript \
    -e 'on run argv' \
    -e 'if (count of argv) > 1 then' \
    -e 'display notification (item 1 of argv) with title "Letta Code" subtitle (item 2 of argv)' \
    -e 'else' \
    -e 'display notification (item 1 of argv) with title "Letta Code"' \
    -e 'end if' \
    -e 'end run' \
    "$@"
}

# Display the notification (show subtitle only for warning/error)
if [ "$level" = "error" ]; then
  notify "$message" "Error"
elif [ "$level" = "warning" ]; then
  notify "$message" "Warning"
else
  notify "$message"
fi

exit 0
