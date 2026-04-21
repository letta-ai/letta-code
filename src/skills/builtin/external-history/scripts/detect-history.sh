#!/bin/bash
# Detect available Claude Code and Codex history on this machine
# Usage: ./detect.sh [project-path]

set -e

PROJECT_PATH="${1:-$(pwd)}"

echo "=== History Detection ==="
echo "Current project: $PROJECT_PATH"
echo ""

# Check Claude Code
if [[ -d "$HOME/.claude" ]]; then
    echo "Claude Code: FOUND at ~/.claude/"
    
    # Count global prompts
    if [[ -f "$HOME/.claude/history.jsonl" ]]; then
        PROMPT_COUNT=$(wc -l < "$HOME/.claude/history.jsonl" | tr -d ' ')
        echo "  Global prompts: $PROMPT_COUNT"
    fi
    
    # Count projects
    if [[ -d "$HOME/.claude/projects" ]]; then
        PROJECT_COUNT=$(ls -d "$HOME/.claude/projects"/*/ 2>/dev/null | wc -l | tr -d ' ')
        echo "  Projects with sessions: $PROJECT_COUNT"
    fi
    
    # Check for current project sessions
    ENCODED=$(echo "$PROJECT_PATH" | sed 's|/|-|g')
    if [[ -d "$HOME/.claude/projects/$ENCODED" ]]; then
        SESSION_COUNT=$(ls "$HOME/.claude/projects/$ENCODED"/*.jsonl 2>/dev/null | wc -l | tr -d ' ')
        echo "  Current project sessions: $SESSION_COUNT"
        
        # Show most recent session info if sessions-index exists
        if [[ -f "$HOME/.claude/projects/$ENCODED/sessions-index.json" ]]; then
            LATEST=$(jq -r '.entries | sort_by(.modified) | last | "\(.modified[0:19]) - \(.firstPrompt[0:60])..."' "$HOME/.claude/projects/$ENCODED/sessions-index.json" 2>/dev/null)
            echo "  Latest session: $LATEST"
        fi
    else
        echo "  Current project sessions: 0 (no session directory)"
        
        # Check history.jsonl for mentions of this project
        if [[ -f "$HOME/.claude/history.jsonl" ]]; then
            HISTORY_MATCHES=$(jq --arg p "$PROJECT_PATH" 'select(.project == $p)' "$HOME/.claude/history.jsonl" 2>/dev/null | wc -l | tr -d ' ')
            if [[ "$HISTORY_MATCHES" -gt 0 ]]; then
                echo "  But found $HISTORY_MATCHES prompts in history.jsonl for this project"
            fi
        fi
    fi
    
    # Total size
    SIZE=$(du -sh "$HOME/.claude" 2>/dev/null | cut -f1)
    echo "  Total size: $SIZE"
    
    # Show settings
    if [[ -f "$HOME/.claude/settings.json" ]]; then
        MODEL=$(jq -r '.model // empty' "$HOME/.claude/settings.json" 2>/dev/null)
        if [[ -n "$MODEL" ]]; then
            echo "  Configured model: $MODEL"
        fi
    fi
else
    echo "Claude Code: NOT FOUND"
fi

echo ""

# Check Codex
if [[ -d "$HOME/.codex" ]]; then
    echo "Codex: FOUND at ~/.codex/"
    
    # Count global prompts
    if [[ -f "$HOME/.codex/history.jsonl" ]]; then
        PROMPT_COUNT=$(wc -l < "$HOME/.codex/history.jsonl" | tr -d ' ')
        echo "  Global prompts: $PROMPT_COUNT"
    fi
    
    # Count sessions
    if [[ -d "$HOME/.codex/sessions" ]]; then
        SESSION_COUNT=$(find "$HOME/.codex/sessions" -name "*.jsonl" 2>/dev/null | wc -l | tr -d ' ')
        echo "  Total sessions: $SESSION_COUNT"
        
        # Check for sessions matching current project
        MATCHING=0
        for f in $(find "$HOME/.codex/sessions" -name "*.jsonl" 2>/dev/null); do
            CWD=$(head -1 "$f" | jq -r '.payload.cwd // empty' 2>/dev/null)
            if [[ "$CWD" == "$PROJECT_PATH"* ]]; then
                ((MATCHING++)) || true
            fi
        done
        echo "  Current project sessions: $MATCHING"
    fi
    
    # Total size
    SIZE=$(du -sh "$HOME/.codex/sessions" 2>/dev/null | cut -f1)
    echo "  Total size: $SIZE"
    
    # Show config
    if [[ -f "$HOME/.codex/config.toml" ]]; then
        MODEL=$(grep "^model" "$HOME/.codex/config.toml" 2>/dev/null | head -1 | cut -d'"' -f2)
        if [[ -n "$MODEL" ]]; then
            echo "  Configured model: $MODEL"
        fi
    fi
else
    echo "Codex: NOT FOUND"
fi

echo ""
echo "=== Summary ==="
[[ -d "$HOME/.claude" ]] && echo "Run: ./list-sessions.sh claude [project-path]"
[[ -d "$HOME/.codex" ]] && echo "Run: ./list-sessions.sh codex [project-path]"
