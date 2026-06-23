---
name: creating-artifacts
description: Creates, updates, tests, and debugs Letta artifact apps in agent memory. Use when the user asks to create, build, update, debug, inspect, or interact with an artifact, app, mini-app, UI, dashboard, todo app, visualization, or interactive artifact stored under external/artifacts.
---

# Creating, Testing, and Debugging Artifacts

Use this skill when creating, updating, testing, or debugging a Letta artifact app.

Artifacts live in agent memory under `external/artifacts/<artifact-name>/`. Use memory file tools to create and edit artifact files; do not write artifact files with local shell filesystem commands.

## Recommended workflow

1. Choose or identify a short kebab-case `<artifact-name>`.
2. Read existing artifact files first when updating/debugging:
   - `external/artifacts/<artifact-name>/metadata.json`
   - `external/artifacts/<artifact-name>/ui/index.html`
   - `external/artifacts/<artifact-name>/server/server.js`
   - `external/artifacts/<artifact-name>/server/data.json`
3. Create or edit the artifact files.
4. If the artifact has server functions, exercise them with `artifact_call`.
5. If the artifact has UI behavior, exercise it with `artifact_interact` snapshots/clicks/inputs/waits.
6. Inspect `artifact_debug_logs` when behavior is unexpected.
7. Fix issues with memory file tools and verify again.
8. Clear debug logs with `artifact_debug_logs({ app_name, clear: true })` after debugging when useful.
9. Final response: mention the artifact name, main files changed, and what was tested.

## File layout

Required files:

```text
external/artifacts/<artifact-name>/metadata.json
external/artifacts/<artifact-name>/ui/index.html
```

Optional persistent/server files:

```text
external/artifacts/<artifact-name>/server/data.json
external/artifacts/<artifact-name>/server/server.js
```

`metadata.json` should include at least:

```json
{
  "name": "Friendly artifact name",
  "description": "Short description shown in the artifact picker"
}
```

`ui/index.html` should be complete, self-contained HTML/CSS/JavaScript. Prefer accessible, responsive UI with no external network dependencies.

## Server behavior

For persistent data, create `server/data.json`. For server-side behavior, create `server/server.js`.

`server/server.js` should default-export a factory returning callable async functions:

```js
export default function createServer({ data }) {
  return {
    async readState() {
      return (await data.read()) ?? { items: [] };
    },

    async updateState(input) {
      const current = (await data.read()) ?? { items: [] };
      const next = { ...current, ...input };
      await data.write(next);
      return next;
    },
  };
}
```

The browser UI can call server functions with:

```js
await window.lettaArtifact.call('readState');
await window.lettaArtifact.call('updateState', { items: [] });
```

Function names must be normal JavaScript identifiers. Return JSON-serializable values and user-friendly errors. Validate and normalize server inputs before use.

## External services

When an artifact needs to interface with an external API or service:

- Put service calls in `server/server.js`, not directly in `ui/index.html`, when the call needs secrets, credentials, private URLs, or durable writes.
- Never write API keys, tokens, cookies, or credentials into `metadata.json`, `ui/index.html`, `server/data.json`, or other memory files.
- Use only secrets/configuration that are already available in the runtime environment. If a required secret is missing, explain what secret is needed instead of inventing one.
- Expose a small, safe function API from `server/server.js`, then call it from the browser with `window.lettaArtifact.call("functionName", args)`.
- Add UI loading, success, and error states around each external-service action.
- Avoid external network dependencies for simple artifacts unless the user explicitly asks for integration.

## Debug logs

Use `artifact_debug_logs` to read logs captured by the open artifact panel. These logs are kept only in the running Letta Code process; they are not written to MemFS.

Artifact tools return compact log tails by default to avoid wasting context. Use `artifact_debug_logs` when detailed logs are needed, and pass `limit` only as high as necessary.

Examples:

```json
{}
```
Lists artifacts with available log snapshots.

```json
{ "app_name": "todo-app" }
```
Reads the latest HTML logs and server/system logs for `todo-app` (defaults to the last 50 per source).

```json
{ "app_name": "todo-app", "limit": 20 }
```
Reads only the last 20 logs per source.

```json
{ "app_name": "todo-app", "clear": true }
```
Clears the in-memory snapshot after debugging.

If no logs are available, ask the user to open the artifact and reproduce the issue, then call `artifact_debug_logs` again.

## Server testing with artifact_call

Use `artifact_call` to call functions exported by `server/server.js` without modifying UI state directly.

```json
{
  "app_name": "todo-app",
  "function_name": "readState"
}
```

```json
{
  "app_name": "todo-app",
  "function_name": "addTodo",
  "args": { "text": "Test todo" }
}
```

`artifact_call` returns JSON containing the result, updated memory paths, and a compact server log tail. It also appends returned server logs to the in-memory artifact debug snapshot.

By default, `artifact_call` returns only the last 5 server logs. Use `log_limit` sparingly, or use `artifact_debug_logs` for detailed log inspection.

## Browser/UI testing with artifact_interact

Use `artifact_interact` to act inside the open artifact iframe. It routes through the connected UI runtime and performs safe DOM actions without arbitrary eval.

By default, `artifact_interact` returns only the last 5 HTML/server logs. Use `log_limit: 0` to omit logs when only the snapshot/result is needed. Use `artifact_debug_logs` for detailed logs.

Inspect the current UI:

```json
{ "app_name": "todo-app", "action": "snapshot", "log_limit": 0 }
```

Click a button:

```json
{
  "app_name": "todo-app",
  "action": "click",
  "selector": "button[data-testid='add-todo']",
  "log_limit": 0
}
```

Fill an input and submit:

```json
{
  "app_name": "todo-app",
  "action": "input",
  "selector": "input[name='todo']",
  "value": "Buy milk",
  "log_limit": 0
}
```

```json
{
  "app_name": "todo-app",
  "action": "submit",
  "selector": "form",
  "log_limit": 0
}
```

Wait for expected UI changes:

```json
{
  "app_name": "todo-app",
  "action": "wait_for_text",
  "text": "Buy milk",
  "timeout_ms": 5000,
  "log_limit": 0
}
```

Wait for any DOM mutation, then return a fresh snapshot:

```json
{
  "app_name": "todo-app",
  "action": "wait_for_change",
  "timeout_ms": 5000,
  "log_limit": 0
}
```

Wait until DOM mutations settle, then return a fresh snapshot:

```json
{
  "app_name": "todo-app",
  "action": "wait_for_idle",
  "timeout_ms": 5000,
  "log_limit": 0
}
```

Supported actions: `snapshot`, `click`, `input`, `select`, `keydown`, `submit`, `wait_for_selector`, `wait_for_text`, `wait_for_change`, `wait_for_idle`.

Recommended UI test loop after an action: `click`/`input`/`submit` → `wait_for_change` or `wait_for_idle` → `snapshot` → inspect `artifact_debug_logs` if behavior is unexpected.

If `artifact_interact` reports that the iframe is not ready, retry once after the artifact panel opens or switches to the requested artifact.

## Debugging limits and cleanup

The browser iframe is sandboxed. Prefer to debug browser-only issues by:

- reading HTML logs from `artifact_debug_logs`,
- taking a UI snapshot with `artifact_interact`,
- using safe `artifact_interact` actions to reproduce clicks/input,
- adding temporary `console.log` diagnostics to `ui/index.html` only when safe actions are insufficient,
- then removing temporary diagnostics before finishing.

Do not write debug logs into memory files unless the user explicitly asks. Keep diagnostics temporary and clean them up.

## Quality checklist

- Write every file with memory file tools, not local shell filesystem writes.
- Keep the first version small and reliable.
- Include loading and error states around `window.lettaArtifact.call` usage.
- Keep secrets out of artifact files and browser code.
- Keep JSON serializable.
- Validate server inputs before using them.
- Test server functions with `artifact_call` when server behavior exists.
- Test UI behavior with `artifact_interact` when the UI is open/available.
- Use compact artifact tool outputs (`log_limit: 0` or small limits) unless debugging logs.
- Clear debug logs when done if they are no longer needed.
- Remove temporary diagnostics before final response.
