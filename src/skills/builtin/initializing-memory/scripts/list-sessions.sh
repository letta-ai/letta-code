#!/bin/bash
# List sessions from a trajectory export directory (see `letta trajectories export`).
# Source-agnostic: sessions from every harness share the trajectory-v1 format.
# Usage: ./list-sessions.sh [export-dir] [--source name] [--project path]

set -e

EXPORT_DIR="/tmp/letta-trajectories"
SOURCE_FILTER=""
PROJECT_FILTER=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --source) SOURCE_FILTER="$2"; shift 2 ;;
        --project) PROJECT_FILTER="$2"; shift 2 ;;
        -*) echo "Unknown option: $1"; exit 1 ;;
        *) EXPORT_DIR="$1"; shift ;;
    esac
done

MANIFEST="$EXPORT_DIR/manifest.json"
if [[ ! -f "$MANIFEST" ]]; then
    echo "No manifest at $MANIFEST"
    echo "Run: letta trajectories export --out $EXPORT_DIR"
    exit 1
fi

jq -r --arg source "$SOURCE_FILTER" --arg project "$PROJECT_FILTER" '
    .sessions[]
    | select($source == "" or .source == $source)
    | select($project == "" or ((.project // "") | startswith($project)))
    | "\((.startedAt // "unknown")[0:19])  \(.source)  msgs:\(.userMessages)  \(.file)\n    \((.firstUserPrompt // "") | gsub("\\s+"; " ") | .[0:90])"
' "$MANIFEST"

echo ""
jq -r '"Total: \(.sessions | length) session(s); errors: \(.errors | length); sources: \(.sources | keys | join(", "))"' "$MANIFEST"
