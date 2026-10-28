Run JavaScript in a persistent session that lasts for this conversation. Use it to call tools programmatically and to start subagent workers that you can steer, pause, and resume from later cells.

A cell is an async function body: use `await`, and `return` the value you want to see. Variables created by bare assignment (`w = ...` or `globalThis.w = ...`) persist across cells; `const`/`let` stay local to the cell.

Globals:
- `tools.<name>(args)` calls a built-in tool and `tools.mcp__server__tool(args)` calls an MCP tool; `listTools()` and `describeTool(name)` list them. Failed calls throw. Calls follow permission rules; calls that need approval fail, so call those tools directly.
- `harness.load(agentId, { ref? })` returns typed views of an agent's memory at one revision. Each namespace has `get(path)` (null if missing): `prompts` (root files compiled into the system prompt every turn: `{ name, description, body }`), `memory` (the on-demand tree: `get('')` is the root and `get('reference')` returns a directory `{ body, files, directories }` whose `body` is its MEMORY.md; `get('reference/notes')` returns a file `{ name, description, body }`; paths have no `.md`), and `skills` (`get(name)` returns `{ description, body, files }`; `get('name/scripts/run.sh')` returns that file's text). `edit({ branch? })` returns an editor whose reads include its staged writes, with the same namespaces plus `put(path, value)` (replaces the node's own document, never its children; a new memory directory needs `{ directory: true, body }`), `update(path, fn)` (`fn` gets the staged value), and `delete(path, { recursive? })`. You write directory bodies, including links to children; `diff()` returns `{ changes, text, links }`, where `links` flags children a body doesn't link to and links that point nowhere. `commit(message?)` commits everything to a new branch (never main) based on the loaded revision and returns `{ sha, branch, base, changed, links }`. Editors also have `apply(changes)`, which replays changes (from another editor's `diff().changes` or `harness.diff`) onto the staged tree: a change applies when the node still matches its `before`, concurrent edits to one document merge line by line when they touch different lines, and the rest come back in `{ applied, merged, conflicts: [{ path, base, ours, theirs }] }` untouched. `harness.diff(agentId, { base, ref })` returns `{ base, ref, changes }` between two revisions; pass an edit's `base` and `branch` to read exactly what it changed. `harness.accept(agentId, ref, { expect })` moves main to `ref` only if main is still at `expect` and `ref` descends from it, and throws otherwise; to land concurrent edits, load main, `apply` each branch's changes, resolve conflicts, `commit`, then `accept(id, branch, { expect: e.base })`, reloading and retrying if main moved. Accepting your own main refreshes your system prompt. Reads and commits follow the same permission rules as file reads and writes. `swap(text, old, new, { all? })` replaces text and throws unless `old` matches exactly once.
- `agent(prompt, opts?)` runs a worker and resolves to its final reply.
- `agent.start(prompt, opts?)` returns a worker handle immediately: `w.send(msg)` interrupts the current turn and continues the worker's conversation with `msg` (`{ interrupt: false }` queues it instead); `w.pause()` interrupts and holds; `w.resume(msg?)` continues; `w.interrupt()` stops the current turn; `w.stop()` closes the worker; `w.result()` resolves to the latest reply once nothing is running or queued; `w.info()` reports `{ id, status, conversationId, turns, lastResult, lastError }`.
- `agent.get(id)` returns a worker by id, label, or conversation ID; `agent.list()` lists all workers.
- `parallel(thunks)`, `pipeline(items, ...stages)`, `args`, and `console.log()` (captured as output).

Worker options: `label`, `model`, `effort`, `allowedTools`, `systemPrompt`, `skills`, `json`, `schema`, `timeoutMs`, `maxToolCalls`, and `conversationId` to continue an existing worker conversation. Model, effort, system prompt, and skills are fixed when the worker starts.

Workers belong to the session, not the cell: they keep running after the cell returns or is stopped. When a worker finishes while no cell is running, you receive a task notification. `reset: true` stops every worker and clears the session.

Returns `{ result, output, workers }`. A cell still running after a brief wait continues in the background and its result arrives as a task notification; TaskStop stops the cell. This is not a security sandbox.

Example:

    reviewer = agent.start("Review src/auth.ts for security bugs.", { label: "auth review" });
    return reviewer.info();

Later cell:

    return await reviewer.send("Also check the session cookie flags, then summarize.");
