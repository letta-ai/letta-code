#!/bin/bash
# List sessions for a project from Claude Code or Codex
# Usage: ./list-sessions.sh <claude|codex> [project-path]

set -e

SOURCE="${1:-claude}"
PROJECT_PATH="${2:-$(pwd)}"

if [[ "$SOURCE" == "claude" ]]; then
    ENCODED=$(echo "$PROJECT_PATH" | sed 's|/|-|g')
    PROJECT_DIR="$HOME/.claude/projects/$ENCODED"
    
    echo "=== Claude Code Sessions ==="
    echo "Project: $PROJECT_PATH"
    echo ""
    
    if [[ -d "$PROJECT_DIR" ]]; then
        # Session files exist - use them
        echo "Source: Session files"
        echo ""
        
        # Use sessions-index.json if available (faster)
        if [[ -f "$PROJECT_DIR/sessions-index.json" ]]; then
            jq -r '.entries | sort_by(.modified) | reverse | .[] | "\(.modified[0:19])  msgs:\(.messageCount|tostring|.[0:4])  \(.firstPrompt[0:70])..."' \
                "$PROJECT_DIR/sessions-index.json"
        else
            # Fall back to parsing each file
            for f in "$PROJECT_DIR"/*.jsonl; do
                [[ -f "$f" ]] || continue
                BASENAME=$(basename "$f")
                FIRST_PROMPT=$(jq -r 'select(.type == "user") | .message.content | if type == "string" then . else .[0].text // .[0].content // "?" end' "$f" 2>/dev/null | head -1 | cut -c1-70)
                MSG_COUNT=$(grep -c '"type"' "$f" 2>/dev/null || echo "?")
                MTIME=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M" "$f" 2>/dev/null || stat -c "%y" "$f" 2>/dev/null | cut -c1-16)
                echo "$MTIME  msgs:$MSG_COUNT  $FIRST_PROMPT..."
                echo "  -> $BASENAME"
            done
        fi
    else
        # No session files - fall back to history.jsonl
        echo "Source: history.jsonl (session files not found)"
        echo "Note: Only prompts available, not full conversations"
        echo ""
        
        if [[ -f "$HOME/.claude/history.jsonl" ]]; then
            MATCHES=$(jq -r --arg proj "$PROJECT_PATH" '
                select(.project == $proj) | 
                "\(.timestamp / 1000 | strftime("%Y-%m-%d %H:%M"))  \(.display[0:70])..."
            ' "$HOME/.claude/history.jsonl" 2>/dev/null)
            
            if [[ -n "$MATCHES" ]]; then
                echo "$MATCHES"
            else
                echo "No prompts found for this exact project path."
                echo "Try searching with a partial match:"
                echo "  cat ~/.claude/history.jsonl | jq 'select(.project | contains(\"$(basename "$PROJECT_PATH")\"))'"
            fi
        else
            echo "No history.jsonl found"
        fi
    fi

elif [[ "$SOURCE" == "codex" ]]; then
    echo "=== Codex Sessions ==="
    echo "Project: $PROJECT_PATH"
    echo ""
    
    FOUND=0
    for f in $(find "$HOME/.codex/sessions" -name "*.jsonl" 2>/dev/null | sort -r); do
        CWD=$(head -1 "$f" | jq -r '.payload.cwd // empty' 2>/dev/null)
        if [[ "$CWD" == "$PROJECT_PATH"* ]]; then
            ((FOUND++)) || true
            BASENAME=$(basename "$f")
            FIRST_PROMPT=$(jq -r 'select(.type == "event_msg" and .payload.type == "user_message") | .payload.message' "$f" 2>/dev/null | head -1 | cut -c1-70)
            TIMESTAMP=$(echo "$BASENAME" | sed 's/rollout-//' | cut -c1-19 | tr 'T' ' ')
            echo "$TIMESTAMP  $FIRST_PROMPT..."
            echo "  -> $f"
        fi
    done
    
    if [[ $FOUND -eq 0 ]]; then
        echo "No Codex sessions found for: $PROJECT_PATH"
    fi
else
    echo "Usage: ./list-sessions.sh <claude|codex> [project-path]"
    exit 1
fi
