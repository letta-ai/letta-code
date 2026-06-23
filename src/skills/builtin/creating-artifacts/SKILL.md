---
name: creating-artifacts
description: Creates Letta artifact apps in agent memory. Use when the user asks to create, build, update, debug, or inspect an artifact, app, mini-app, UI, dashboard, todo app, visualization, or interactive artifact stored under external/artifacts.
---

# Creating Artifacts

Use this skill when creating or updating a Letta artifact app.

## Artifact location

Use memory file tools to write files under:

```text
external/artifacts/<artifact-name>/
```

Choose a short kebab-case `<artifact-name>`.

## Required files

Create these files:

```text
external/artifacts/<artifact-name>/metadata.json
external/artifacts/<artifact-name>/ui/index.html
```

`metadata.json` should include at least:

```json
{
  "name": "Friendly artifact name",
  "description": "Short description shown in the artifact picker"
}
```

`ui/index.html` should be complete, self-contained HTML/CSS/JavaScript. Prefer accessible, responsive UI with no external network dependencies.

## Optional persistent/server behavior

For persistent data, create:

```text
external/artifacts/<artifact-name>/server/data.json
```

For server-side behavior, create:

```text
external/artifacts/<artifact-name>/server/server.js
```

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

Function names must be normal JavaScript identifiers.

## External services

When an artifact needs to interface with an external API or service:

- Put service calls in `server/server.js`, not directly in `ui/index.html`, when the call needs secrets, credentials, private URLs, or durable writes.
- Never write API keys, tokens, cookies, or credentials into `metadata.json`, `ui/index.html`, `server/data.json`, or other memory files.
- Use only secrets/configuration that are already available in the runtime environment. If a required secret is missing, explain what secret is needed instead of inventing one.
- Expose a small, safe function API from `server/server.js`, then call it from the browser with `window.lettaArtifact.call("functionName", args)`.
- Validate and normalize inputs in `server/server.js` before using them in service calls.
- Return JSON-serializable results and user-friendly error messages to the UI.
- Add UI loading, success, and error states around each external-service action.
- Avoid external network dependencies for simple artifacts unless the user explicitly asks for integration.

## Quality checklist

- Write every file with memory file tools, not local shell filesystem writes.
- Keep the first version small and reliable.
- Include loading and error states around `window.lettaArtifact.call` usage.
- Keep secrets out of artifact files and browser code.
- Keep JSON serializable.
- After creating files, mention the artifact name and main files created.
