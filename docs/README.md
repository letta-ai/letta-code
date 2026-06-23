# Letta Code artifact apps

Artifact apps live in an agent's MemFS `external/artifacts/` directory. They split browser UI from server-side state and logic so the same app can run in Desktop or in a browser connected to a remote Letta Code runtime.

## Directory structure

```text
external/
  artifacts/
    my-app/
      ui/
        index.html
        # other browser assets
      server/
        data.json
        server.js
```

## Browser UI

`ui/index.html` is rendered in a sandboxed iframe. Letta Code injects a small browser proxy:

```js
await window.lettaArtifact.call('readState');
await window.lettaArtifact.call('updateState', { title: 'New title' });
```

The browser never reads or writes MemFS directly. Calls are sent over the active websocket connection to the Letta Code runtime.

## Server module

`server/server.js` runs on the Letta Code side. It must export a function that returns an object whose keys are callable RPC functions:

```js
export default function createServer({ data }) {
  return {
    async readState() {
      return (await data.read()) ?? { items: [] };
    },

    async updateState(input) {
      const current = (await data.read()) ?? { items: [] };
      const next = {
        ...current,
        items: [...current.items, input],
      };
      await data.write(next);
      return next;
    },
  };
}
```

Function names must be normal JavaScript identifiers. Prototype-related names such as `constructor` and `__proto__` are rejected.

## Data

`server/data.json` is the default durable state file. It is JSON so MemFS can diff, sync, and merge it like the rest of agent memory.

The server context exposes:

```js
data.path       // absolute path to server/data.json
data.read()     // Promise<unknown | null>
data.write(obj) // pretty-prints JSON and writes server/data.json
```

Keep data JSON-serializable. RPC return values are also serialized before being sent back to the browser.

## Debugging

The Artifacts panel includes a bottom debug bar. Open **Debug** to split the view and inspect:

- **HTML logs** — `console.log`, `console.warn`, `console.error`, uncaught errors, unhandled promise rejections, and artifact RPC lifecycle messages from `ui/index.html`.
- **Server logs** — `console.log`, `console.warn`, `console.error`, and related console output emitted while `server/server.js` handles an artifact RPC call.

Use **Send to agent** to send the collected logs back into the current agent conversation for debugging.
