#!/bin/bash
# View a normalized trajectory session file in readable form.
# Source-agnostic: sessions from every harness (claude-code, codex, letta,
# openhands, ...) share the trajectory-v1 format.
# Usage: ./view-session.sh <trajectory-file.json> [--tools] [--reasoning]

set -e

SESSION_FILE="$1"
SHOW_TOOLS=false
SHOW_REASONING=false

shift || true
while [[ $# -gt 0 ]]; do
    case $1 in
        --tools) SHOW_TOOLS=true; shift ;;
        --reasoning|--thinking) SHOW_REASONING=true; shift ;;
        *) shift ;;
    esac
done

if [[ -z "$SESSION_FILE" || ! -f "$SESSION_FILE" ]]; then
    echo "Usage: ./view-session.sh <trajectory-file.json> [--tools] [--reasoning]"
    echo ""
    echo "Options:"
    echo "  --tools      Show tool calls and tool results"
    echo "  --reasoning  Show model reasoning records"
    exit 1
fi

jq -r --argjson tools "$SHOW_TOOLS" --argjson reasoning "$SHOW_REASONING" '
    .[]
    | if .role == "meta" then
        "=== \(.source) session ===\nProject: \(.cwd // "?")   Model: \(.model // "?")   Branch: \(.git_branch // "?")\n"
      elif .role == "user" then
        ">>> USER [\((.timestamp // "")[0:19])]:\n\(.content)\n"
      elif .role == "assistant" and (has("tool_calls") | not) then
        "<<< ASSISTANT [\((.timestamp // "")[0:19])]:\n\(.content // "")\n"
      elif .role == "assistant" then
        if $tools then
          "<<< TOOL CALLS: \([.tool_calls[] | "\(.name)(\(.args | .[0:150]))"] | join("; "))\n"
        else empty end
      elif .role == "tool" then
        if $tools then
          ">>> TOOL RESULT:\n\(.content | .[0:500])\n"
        else empty end
      elif .role == "reasoning" then
        if $reasoning then
          "<<< REASONING:\n\(.content | .[0:300])\n"
        else empty end
      else empty end
' "$SESSION_FILE"
