#!/bin/bash
# Detect available Claude Code and Codex history data
# Usage: ./detect.sh [project-path]

set -e

PROJECT_PATH="${1:-$(pwd)}"

echo "=== History Data Detection ==="
echo ""

# Claude Code
if [[ -d "$HOME/.claude" ]]; then
    echo "Claude Code: FOUND"
    echo "  Location: ~/.claude/"
    
    # Count global prompts
    if [[ -f "$HOME/.claude/history.jsonl" ]]; then
        PROMPT_COUNT=$(wc -l < "$HOME/.claude/history.jsonl" | tr -d ' ')
        echo "  Global prompts: $PROMPT_COUNT"
    fi
    
    # Count projects
    if [[ -d "$HOME/.claude/projects" ]]; then
        PROJECT_COUNT=$(ls -1 "$HOME/.claude/projects" 2>/dev/null | wc -l | tr -d ' ')
        echo "  Projects: $PROJECT_COUNT"
        
        # Check for current project
        ENCODED=$(echo "$PROJECT_PATH" | sed 's|/|-|g')
        if [[ -d "$HOME/.claude/projects/$ENCODED" ]]; then
            SESSION_COUNT=$(ls -1 "$HOME/.claude/projects/$ENCODED"/*.jsonl 2>/dev/null | wc -l | tr -d ' ')
            echo "  Current project sessions: $SESSION_COUNT"
            
            # Show sessions index if available
            if [[ -f "$HOME/.claude/projects/$ENCODED/sessions-index.json" ]]; then
                echo ""
                echo "  Recent sessions in this project:"
                jq -r '.entries | sort_by(.modified) | reverse | .[0:5][] | "    \(.modified[0:10]) - \(.firstPrompt[0:60])..."' \
                    "$HOME/.claude/projects/$ENCODED/sessions-index.json" 2>/dev/null || true
            fi
        else
            echo "  Current project: No sessions found"
        fi
    fi
    
    # Total size
    SIZE=$(du -sh "$HOME/.claude/projects" 2>/dev/null | cut -f1)
    echo "  Total size: $SIZE"
else
    echo "Claude Code: NOT FOUND"
fi

echo ""

# Codex
if [[ -d "$HOME/.codex" ]]; then
    echo "Codex: FOUND"
    echo "  Location: ~/.codex/"
    
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
