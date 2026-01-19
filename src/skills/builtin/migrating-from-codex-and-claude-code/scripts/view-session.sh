#!/bin/bash
# View a session file in readable format
# Usage: ./view-session.sh <session-file> [--tools] [--thinking]

set -e

SESSION_FILE="$1"
SHOW_TOOLS=false
SHOW_THINKING=false

# Parse flags
shift || true
while [[ $# -gt 0 ]]; do
    case $1 in
        --tools) SHOW_TOOLS=true; shift ;;
        --thinking) SHOW_THINKING=true; shift ;;
        *) shift ;;
    esac
done

if [[ -z "$SESSION_FILE" || ! -f "$SESSION_FILE" ]]; then
    echo "Usage: ./view-session.sh <session-file> [--tools] [--thinking]"
    echo ""
    echo "Options:"
    echo "  --tools     Show tool calls and results"
    echo "  --thinking  Show assistant thinking/reasoning"
    exit 1
fi

# Detect format (Claude vs Codex)
FIRST_LINE=$(head -1 "$SESSION_FILE")
if echo "$FIRST_LINE" | jq -e '.type == "session_meta"' > /dev/null 2>&1; then
    FORMAT="codex"
elif echo "$FIRST_LINE" | jq -e '.type' > /dev/null 2>&1; then
    FORMAT="claude"
else
    echo "Unknown session format"
    exit 1
fi

echo "=== Session Viewer ==="
echo "File: $SESSION_FILE"
echo "Format: $FORMAT"
echo ""

if [[ "$FORMAT" == "claude" ]]; then
    # Claude format
    jq -r --argjson tools "$SHOW_TOOLS" --argjson thinking "$SHOW_THINKING" '
        if .type == "user" then
            .message.content |
            if type == "string" then
                ">>> USER:\n\(.)\n"
            elif .[0].type == "tool_result" then
                if $tools then
                    ">>> TOOL RESULT (\(.[0].tool_use_id[0:20])):\n\(.[0].content[0:500])...\n"
                else
                    empty
                end
            else
                ">>> USER:\n\(.[0].text // .[0].content // "?")\n"
            end
        elif .type == "assistant" then
            .message.content | map(
                if .type == "text" then
                    "<<< ASSISTANT:\n\(.text)\n"
                elif .type == "thinking" and $thinking then
                    "<<< THINKING:\n\(.thinking[0:300])...\n"
                elif .type == "tool_use" and $tools then
                    "<<< TOOL: \(.name)\n\(.input | tostring[0:200])...\n"
                else
                    empty
                end
            ) | join("\n")
        elif .type == "summary" then
            "=== SUMMARY: \(.summary) ===\n"
        else
            empty
        end
    ' "$SESSION_FILE"
    
elif [[ "$FORMAT" == "codex" ]]; then
    # Codex format
    
    # Show session metadata
    jq -r 'select(.type == "session_meta") | "Project: \(.payload.cwd)\nModel: \(.payload.model_provider // "?")\nBranch: \(.payload.git.branch // "?")\n"' "$SESSION_FILE" | head -5
    echo "---"
    echo ""
    
    jq -r --argjson tools "$SHOW_TOOLS" --argjson thinking "$SHOW_THINKING" '
        if .type == "event_msg" and .payload.type == "user_message" then
            ">>> USER:\n\(.payload.message)\n"
        elif .type == "response_item" and .payload.type == "message" and .payload.role == "assistant" then
            .payload.content | map(
                if .type == "output_text" then
                    "<<< ASSISTANT:\n\(.text)\n"
                else
                    empty
                end
            ) | join("\n")
        elif .type == "event_msg" and .payload.type == "agent_reasoning" and $thinking then
            "<<< THINKING:\n\(.payload.text[0:300])...\n"
        elif .type == "response_item" and .payload.type == "function_call" and $tools then
            "<<< TOOL: \(.payload.name)\n\(.payload.arguments[0:200])...\n"
        elif .type == "response_item" and .payload.type == "function_call_output" and $tools then
            ">>> TOOL RESULT:\n\(.payload.output[0:500])...\n"
        else
            empty
        end
    ' "$SESSION_FILE"
fi
