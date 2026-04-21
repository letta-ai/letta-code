#!/bin/bash
# Search across Claude Code and Codex history
# Usage: ./search.sh <keyword> [--claude|--codex|--both] [--project path]

set -e

KEYWORD=""
SOURCE="both"
PROJECT_FILTER=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --claude) SOURCE="claude"; shift ;;
        --codex) SOURCE="codex"; shift ;;
        --both) SOURCE="both"; shift ;;
        --project) PROJECT_FILTER="$2"; shift 2 ;;
        -*) echo "Unknown option: $1"; exit 1 ;;
        *) KEYWORD="$1"; shift ;;
    esac
done

if [[ -z "$KEYWORD" ]]; then
    echo "Usage: ./search.sh <keyword> [--claude|--codex|--both] [--project path]"
    echo ""
    echo "Examples:"
    echo "  ./search.sh 'database migration'"
    echo "  ./search.sh 'test' --claude"
    echo "  ./search.sh 'auth' --project /path/to/project"
    exit 1
fi

echo "=== Searching for: $KEYWORD ==="
echo ""

# Search Claude Code
if [[ "$SOURCE" == "claude" || "$SOURCE" == "both" ]] && [[ -d "$HOME/.claude" ]]; then
    echo "--- Claude Code Results ---"
    
    # Search global history (always available, even when session files are deleted)
    if [[ -f "$HOME/.claude/history.jsonl" ]]; then
        echo "Prompt history (history.jsonl):"
        if [[ -n "$PROJECT_FILTER" ]]; then
            RESULTS=$(jq -r --arg kw "$KEYWORD" --arg proj "$PROJECT_FILTER" '
                select((.display | test($kw; "i")) and (.project | startswith($proj))) | 
                "\(.timestamp / 1000 | strftime("%Y-%m-%d %H:%M"))  \(.display[0:80])..."
            ' "$HOME/.claude/history.jsonl" 2>/dev/null | head -30)
        else
            RESULTS=$(jq -r --arg kw "$KEYWORD" '
                select(.display | test($kw; "i")) | 
                "\(.timestamp / 1000 | strftime("%Y-%m-%d %H:%M"))  \(.project | split("/") | .[-1]):  \(.display[0:70])..."
            ' "$HOME/.claude/history.jsonl" 2>/dev/null | head -30)
        fi
        if [[ -n "$RESULTS" ]]; then
            echo "$RESULTS"
        else
            echo "  No matches in prompt history"
        fi
        echo ""
    fi
    
    # Search session files
    echo ""
    echo "Session matches:"
    for PROJECT_DIR in "$HOME/.claude/projects"/*; do
        [[ -d "$PROJECT_DIR" ]] || continue
        
        # Apply project filter if specified
        if [[ -n "$PROJECT_FILTER" ]]; then
            DECODED=$(basename "$PROJECT_DIR" | sed 's/-/\//g')
            [[ "$DECODED" == "$PROJECT_FILTER"* ]] || continue
        fi
        
        for f in "$PROJECT_DIR"/*.jsonl; do
            [[ -f "$f" ]] || continue
            [[ "$(basename "$f")" == "sessions-index.json" ]] && continue
            
            # Search user messages (string content only)
            MATCHES=$(jq -r --arg kw "$KEYWORD" '
                select(.type == "user" and (.message.content | type == "string")) | 
                .message.content |
                select(test($kw; "i"))
            ' "$f" 2>/dev/null | head -3)
            
            if [[ -n "$MATCHES" ]]; then
                PROJECT_NAME=$(basename "$PROJECT_DIR" | sed 's/-/\//g' | rev | cut -c1-50 | rev)
                echo ""
                echo "  Project: ...$PROJECT_NAME"
                echo "  Session: $(basename "$f")"
                echo "$MATCHES" | while read -r line; do
                    echo "    > ${line:0:80}..."
                done
            fi
        done
    done
    echo ""
fi

# Search Codex
if [[ "$SOURCE" == "codex" || "$SOURCE" == "both" ]] && [[ -d "$HOME/.codex" ]]; then
    echo "--- Codex Results ---"
    
    # Search global history
    if [[ -f "$HOME/.codex/history.jsonl" ]]; then
        RESULTS=$(jq -r --arg kw "$KEYWORD" 'select(.text | test($kw; "i")) | "\(.ts | strftime("%Y-%m-%d %H:%M"))  \(.text[0:100])...\n"' "$HOME/.codex/history.jsonl" 2>/dev/null | head -20)
        if [[ -n "$RESULTS" ]]; then
            echo "Global history matches:"
            echo "$RESULTS"
        fi
    fi
    
    # Search session files
    echo "Session matches:"
    for f in $(find "$HOME/.codex/sessions" -name "*.jsonl" 2>/dev/null); do
        # Apply project filter if specified
        if [[ -n "$PROJECT_FILTER" ]]; then
            CWD=$(head -1 "$f" | jq -r '.payload.cwd // empty' 2>/dev/null)
            [[ "$CWD" == "$PROJECT_FILTER"* ]] || continue
        fi
        
        MATCHES=$(jq -r --arg kw "$KEYWORD" '
            select(.type == "event_msg" and .payload.type == "user_message") |
            .payload.message |
            select(test($kw; "i"))
        ' "$f" 2>/dev/null | head -3)
        
        if [[ -n "$MATCHES" ]]; then
            echo ""
            echo "  File: $(basename "$f")"
            CWD=$(head -1 "$f" | jq -r '.payload.cwd // "?"' 2>/dev/null)
            echo "  Project: $CWD"
            echo "$MATCHES" | while read -r line; do
                echo "    ${line:0:100}..."
            done
        fi
    done
fi
