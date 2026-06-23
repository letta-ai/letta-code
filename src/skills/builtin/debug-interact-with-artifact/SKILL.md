---
name: debug-interact-with-artifact
description: Debugs and exercises Letta artifact apps without polluting memory. Use when an artifact UI/server is broken, logs are needed, artifact RPC calls fail, the user asks to debug an artifact, or the agent needs to inspect artifact behavior under external/artifacts.
---

# Debug and Interact with Artifacts

Use this skill when debugging an artifact app in `external/artifacts/<artifact-name>/`.

## Workflow

1. Identify the artifact name from the user, the artifact picker, or files under `external/artifacts/`.
2. Inspect source files with normal read/search tools:
   - `external/artifacts/<artifact-name>/metadata.json`
   - `external/artifacts/<artifact-name>/ui/index.html`
   - `external/artifacts/<artifact-name>/server/server.js`
   - `external/artifacts/<artifact-name>/server/data.json`
3. Read runtime logs with `artifact_debug_logs`.
4. Exercise server behavior with `artifact_call`.
5. Fix artifact files with memory file tools.
6. Re-read logs or call functions again to verify.
7. Clear debug logs with `artifact_debug_logs({ app_name, clear: true })` after debugging.

## In-memory logs

Use `artifact_debug_logs` to read logs captured by the open artifact panel. These logs are kept only in the running Letta Code process; they are not written to MemFS.

Examples:

```json
{}
```
Lists artifacts with available log snapshots.

```json
{ "app_name": "todo-app" }
```
Reads HTML logs and server/system logs for `todo-app`.

```json
{ "app_name": "todo-app", "clear": true }
```
Clears the in-memory snapshot after debugging.

If no logs are available, ask the user to open the artifact and reproduce the issue, then call `artifact_debug_logs` again.

## Server interaction

Use `artifact_call` to call functions exported by `server/server.js` without modifying UI state directly.

Example:

```json
{
  "app_name": "todo-app",
  "function_name": "readState"
}
```

Example with args:

```json
{
  "app_name": "todo-app",
  "function_name": "addTodo",
  "args": { "text": "Test todo" }
}
```

`artifact_call` returns JSON containing the result, updated memory paths, and server logs. It also appends returned server logs to the in-memory artifact debug snapshot.

## Browser/UI interaction limits

The browser iframe is sandboxed. Prefer to debug browser-only issues by:

- reading HTML logs from `artifact_debug_logs`,
- adding temporary `console.log` diagnostics to `ui/index.html`,
- asking the user to reproduce the UI interaction,
- then removing temporary diagnostics before finishing.

Do not write debug logs into memory files unless the user explicitly asks. Keep diagnostics temporary and clean them up.

## Checklist

- Keep secrets out of browser code and memory files.
- Validate server inputs before using them.
- Return JSON-serializable values from server functions.
- Clear debug logs when done.
- Remove temporary diagnostics before final response.
