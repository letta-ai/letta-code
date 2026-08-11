---
name: downloading-sandbox-files
description: Downloads a file from the current agent conversation's managed cloud sandbox onto the computer running Letta Code. Use when the user asks to download, copy, retrieve, or save a file from a cloud sandbox to their local machine.
---

# Downloading Sandbox Files

Download one file from the current conversation's cloud sandbox to a destination chosen by the user.

## Workflow

1. Confirm the current Bash environment is the computer where the user wants the file saved. If this agent is itself running inside the managed cloud sandbox, stop: downloading through the endpoint would save the file back into that sandbox.
2. Ask for the sandbox source path or local destination only if either is missing. Never guess an overwrite destination.
3. Require `LETTA_BASE_URL`, `LETTA_API_KEY`, and `LETTA_AGENT_ID`. Use `LETTA_CONVERSATION_ID` when it identifies a real conversation; draft values (`default`, `new`, or empty) use the agent-scoped sandbox instead.
4. Resolve the newest matching sandbox, then stream the file directly to the destination:

```bash
: "${LETTA_BASE_URL:?LETTA_BASE_URL is required}"
: "${LETTA_API_KEY:?LETTA_API_KEY is required}"
: "${LETTA_AGENT_ID:?LETTA_AGENT_ID is required}"

sandbox_path="/root/workspace/path/to/file"
destination="./file"
base_url="${LETTA_BASE_URL%/}"

query_args=(
  --data-urlencode "agentId=$LETTA_AGENT_ID"
  --data-urlencode "limit=1"
)
if [[ -n "${LETTA_CONVERSATION_ID:-}" && "$LETTA_CONVERSATION_ID" != "default" && "$LETTA_CONVERSATION_ID" != "new" ]]; then
  query_args+=(--data-urlencode "conversationId=$LETTA_CONVERSATION_ID")
fi

sandbox_id="$({
  curl -fsS --get "$base_url/v1/sandboxes" \
    -H "Authorization: Bearer $LETTA_API_KEY" \
    "${query_args[@]}"
} | node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const sandbox = JSON.parse(input).sandboxes?.[0];
  if (!sandbox?.sandboxId) {
    console.error("No matching cloud sandbox found");
    process.exit(1);
  }
  process.stdout.write(sandbox.sandboxId);
});
')"

curl -fSL --remove-on-error --get \
  "$base_url/v1/sandboxes/$sandbox_id/files/download" \
  -H "Authorization: Bearer $LETTA_API_KEY" \
  --data-urlencode "path=$sandbox_path" \
  --output "$destination"
```

5. Verify that the destination exists and report its path. Do not print binary contents.

Always pair the runtime-provided `LETTA_BASE_URL` and `LETTA_API_KEY`; never hardcode `api.letta.com` or request a Daytona API key. This endpoint supports files only, not directories. Archive a directory inside the sandbox first, then download the archive.
