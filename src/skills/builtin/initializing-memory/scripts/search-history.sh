#!/bin/bash
# Search user/assistant messages across all sessions in a trajectory export
# directory (see `letta trajectories export`). Source-agnostic: sessions from
# every harness share the trajectory-v1 format.
# Usage: ./search-history.sh <keyword> [export-dir] [--source name] [--project path] [--role user|assistant]

set -e

KEYWORD=""
EXPORT_DIR="/tmp/letta-trajectories"
SOURCE_FILTER=""
PROJECT_FILTER=""
ROLE_FILTER=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --source) SOURCE_FILTER="$2"; shift 2 ;;
        --project) PROJECT_FILTER="$2"; shift 2 ;;
        --role) ROLE_FILTER="$2"; shift 2 ;;
        -*) echo "Unknown option: $1"; exit 1 ;;
        *)
            if [[ -z "$KEYWORD" ]]; then KEYWORD="$1"; else EXPORT_DIR="$1"; fi
            shift ;;
    esac
done

if [[ -z "$KEYWORD" ]]; then
    echo "Usage: ./search-history.sh <keyword> [export-dir] [--source name] [--project path] [--role user|assistant]"
    echo ""
    echo "Examples:"
    echo "  ./search-history.sh 'database migration'"
    echo "  ./search-history.sh 'uv run' --role user"
    echo "  ./search-history.sh 'auth' --project /path/to/project --source codex"
    exit 1
fi

MANIFEST="$EXPORT_DIR/manifest.json"
if [[ ! -f "$MANIFEST" ]]; then
    echo "No manifest at $MANIFEST"
    echo "Run: letta trajectories export --out $EXPORT_DIR"
    exit 1
fi

echo "=== Searching for: $KEYWORD ==="

jq -r --arg source "$SOURCE_FILTER" --arg project "$PROJECT_FILTER" '
    .sessions[]
    | select($source == "" or .source == $source)
    | select($project == "" or ((.project // "") | startswith($project)))
    | .file
' "$MANIFEST" | while read -r file; do
    MATCHES=$(jq -r --arg kw "$KEYWORD" --arg role "$ROLE_FILTER" '
        .[]
        | select(.role == "user" or .role == "assistant")
        | select($role == "" or .role == $role)
        | select((.content // "") | test($kw; "i"))
        | "  [\((.timestamp // "")[0:19])] \(.role): \(.content | gsub("\\s+"; " ") | .[0:160])"
    ' "$EXPORT_DIR/$file" 2>/dev/null | head -5)
    if [[ -n "$MATCHES" ]]; then
        echo ""
        echo "--- $file ---"
        echo "$MATCHES"
    fi
done
